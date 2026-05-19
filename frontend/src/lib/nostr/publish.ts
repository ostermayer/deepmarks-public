// Publish helpers — every signed event is POSTed through our server,
// which queues it and forwards to relay.deepmarks.org on the user's
// behalf. The user's IP never appears in relay event metadata: anyone
// scraping the relay sees "all events from <our server>", and the
// HTTPS hop to our edge is the same surface as any other API call.
//
// UX win: the POST returns 202 the moment the queue accepts the
// event, so the client never sits waiting for a relay round-trip.
// Strfry's writePolicy (registered-pubkey gate, kind:1 shadow-reject
// + fanout) and the relay-fanout worker (NIP-65 broadcast to the
// user's other relays) take it from there asynchronously.

import { NDKEvent, NDKRelaySet } from '@nostr-dev-kit/ndk';
import { get } from 'svelte/store';
import { getNdk } from './ndk.js';
import type { UnsignedEventTemplate } from './bookmarks.js';
import { config } from '$lib/config.js';
import { KIND } from './kinds.js';
import { userSettings, type RelayConfig } from '$lib/stores/user-settings';
import { enqueuePendingPublish, setPendingPublishImpl } from './pending-publish.js';
import { buildNip98AuthHeader } from '$lib/api/client.js';

export interface PublishResult {
  eventId: string;
  relays: string[];
  warning?: string;
}

// Bumped from 8s → 20s after iOS WKWebView foreground transitions
// aborted in-flight POSTs while the network connection was still
// being re-established. 8s was too tight when the share-extension
// drainer hit /publish in the first second of foreground.
const PUBLISH_API_TIMEOUT_MS = 20_000;
const PUBLISH_RETRY_DELAY_MS = 1_500;
const INGEST_TIMEOUT_MS = 3500;

/**
 * Replaceable kinds — addressable parameterized replaceable per NIP-01 — live
 * in [30000, 40000). We treat them as addressable when they carry a `d` tag.
 * Exposed for testing.
 */
export function isParameterizedReplaceable(template: UnsignedEventTemplate): boolean {
  if (template.kind < 30000 || template.kind >= 40000) return false;
  return template.tags.some((t) => t[0] === 'd' && typeof t[1] === 'string');
}

export function relayUrlsForPublish(_relays: RelayConfig[] = get(userSettings).relays): string[] {
  // Kept for API compatibility — older callers asked "where will this
  // publish?" before the server-mediated rewrite. The answer is still
  // relay.deepmarks.org canonically; the server fans out from there
  // via the relay-fanout worker.
  return [config.deepmarksRelay];
}

export function relaySetForPublish(ndk = getNdk()): NDKRelaySet {
  return NDKRelaySet.fromRelayUrls(relayUrlsForPublish(), ndk, true);
}

/**
 * Sign + POST one event through our server. The client never opens a
 * relay WebSocket for the publish itself — every byte that lands on
 * relay.deepmarks.org enters via our payment-proxy, so user IPs are
 * not coupled to relay-event metadata.
 *
 * Hard network failures (signer error, server unreachable) enqueue
 * the template into the durable-publish queue so a later drain pass
 * picks it up. Soft failures (server queues but worker drops) are
 * not currently re-driven from the client; the relay-fanout worker
 * owns retry beyond the queue boundary.
 */
export async function publishEvent(
  template: UnsignedEventTemplate,
  pubkey: string
): Promise<PublishResult> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('No signer attached. Sign in first.');

  // Build the NDKEvent + sign it WITHOUT publishing. Signing still
  // goes through the user's chosen signer (passkey/local nsec for
  // instant signing, NIP-46 bunker for users who keep keys on Box C),
  // but the publish step is now an HTTPS POST.
  const event = new NDKEvent(ndk, {
    kind: template.kind,
    pubkey,
    created_at: template.created_at,
    tags: template.tags,
    content: template.content,
  });
  await event.sign();

  const signed = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at!,
    kind: event.kind!,
    tags: event.tags,
    content: event.content,
    sig: event.sig!,
  };

  const url = `${config.apiBase}/publish`;
  const body = JSON.stringify({ events: [signed] });
  // One retry on transient failures — iOS WKWebView aborts pending
  // fetches when the app foregrounds, so the share-drain's first
  // POST often hits an AbortError or "network connection was lost"
  // while the connection is being re-established. A short delay
  // gives iOS a chance to reconnect.
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const auth = await buildNip98AuthHeader(url, 'POST', body);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PUBLISH_API_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        // Non-2xx is treated as a permanent failure — server actively
        // rejected us. No retry, surface to caller + enqueue for the
        // durable drainer.
        throw new Error(`publish ${res.status}: ${errBody.slice(0, 200)}`);
      }
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const transient = isTransientFetchError(error);
      // Only retry the iOS foreground / network-lost cases. Anything
      // else (signer failure, server reject, etc.) bails out.
      if (attempt < 1 && transient) {
        await new Promise((resolve) => setTimeout(resolve, PUBLISH_RETRY_DELAY_MS));
        continue;
      }
      break;
    }
  }
  if (lastError) {
    // POST failed even after the retry — durable-publish takes over
    // so the user's save eventually reaches the relay. The thrown
    // error still flows up to the caller for UI surfacing.
    enqueuePendingPublish(template, pubkey, lastError instanceof Error ? lastError.message : String(lastError));
    throw lastError;
  }

  // Trigger the kind:39701 indexer ingest in the background. Without
  // this the Meilisearch index lags by however long the relay-fanout
  // worker takes to drain its queue + the indexer's own subscription
  // latency. The server returns 200 even on bad input so it's
  // safe-and-fire-and-forget.
  if (template.kind === KIND.webBookmark) {
    void notifyPublicBookmarkIngest(signed).catch((err) => {
      console.warn('Deepmarks bookmark ingest failed:', err);
    });
  }

  return {
    eventId: event.id,
    relays: [config.deepmarksRelay],
  };
}

// Late-bound so the durable-publish drainer can call publishEvent
// without pulling pending-publish.ts into our import cycle.
setPendingPublishImpl((template, pubkey) => publishEvent(template, pubkey).then(({ relays }) => ({ relays })));

/**
 * Fan out a batch of templates to publishEvent concurrently. Used
 * anywhere a single user action produces multiple events (private-set
 * chunked writes, multi-chunk archive-keys publishes). Same NIP-46/NIP-07
 * signing-serialization happens inside publishEvent — this just lets the
 * relay round-trips overlap so a 25-chunk edit completes in seconds
 * instead of stacking 25× per-chunk latency.
 *
 * The shape matches the most-common caller pattern: return the result
 * list (so callers that want `lastEventId` can read `results.at(-1)`),
 * and let any per-template failure reject the whole Promise so the UI
 * surfaces it instead of silently dropping events.
 */
export async function publishAll(
  templates: readonly UnsignedEventTemplate[],
  pubkey: string,
): Promise<PublishResult[]> {
  if (templates.length === 0) return [];
  return Promise.all(templates.map((t) => publishEvent(t, pubkey)));
}

/** True when a fetch failed in a way iOS WKWebView is likely to
 *  recover from on retry — AbortError (our own timeout), the iOS
 *  "network connection was lost" message, or a generic TypeError
 *  from a dropped socket. */
function isTransientFetchError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string };
  if (e.name === 'AbortError') return true;
  if (typeof e.message !== 'string') return false;
  const msg = e.message;
  return /network connection was lost|load failed|failed to fetch|connection reset|the request timed out|net::err_/i
    .test(msg);
}

async function notifyPublicBookmarkIngest(event: unknown): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.apiBase}/bookmarks/public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`${res.status} ${await res.text().catch(() => '')}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
