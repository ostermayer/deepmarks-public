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
import type { SignedEventLike, UnsignedEventTemplate } from './bookmarks.js';
import { config } from '$lib/config.js';
import { KIND } from './kinds.js';
import { userSettings, type RelayConfig } from '$lib/stores/user-settings';
import { enqueuePendingPublish, removePendingPublish, setPendingPublishImpl } from './pending-publish.js';
import { buildNip98AuthHeader } from '$lib/api/client.js';

export interface PublishResult {
  eventId: string;
  relays: string[];
  warning?: string;
}

export type SignedPublishEvent = SignedEventLike & { sig: string };

export interface PublishEventOptions {
  /**
   * Called after the event itself has been signed and, when
   * queueBeforePost is enabled, staged in the durable retry queue.
   */
  onReadyToPost?: (event: SignedPublishEvent) => void;
  /**
   * Queue the template before the network POST. On success the queue entry
   * is removed; on failure the durable drainer retries it later.
   */
  queueBeforePost?: boolean;
  /** User-facing noun used in publish failure copy. */
  failureSubject?: string;
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

/**
 * Sign + POST one event through our server. The client never opens a
 * relay WebSocket for the publish itself — every byte that lands on
 * relay.deepmarks.org enters via our api, so user IPs are
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
  pubkey: string,
  options: PublishEventOptions = {},
): Promise<PublishResult> {
  const signed = await signEventTemplate(template, pubkey);

  let queuedBeforePost = false;
  if (options.queueBeforePost) {
    queuedBeforePost = enqueuePendingPublish(template, pubkey, 'queued before network publish');
  }
  if (!options.queueBeforePost || queuedBeforePost) {
    options.onReadyToPost?.(signed);
  }

  return postSignedEventToApi(signed, template, pubkey, options, queuedBeforePost);
}

async function postSignedEventToApi(
  signed: SignedPublishEvent,
  template: UnsignedEventTemplate,
  pubkey: string,
  options: PublishEventOptions,
  queuedBeforePost: boolean,
): Promise<PublishResult> {
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
        // rejected us. No retry, surface safe copy to the caller and
        // enqueue for the durable drainer.
        throw new Error(formatPublishHttpError(res.status, errBody, options.failureSubject));
      }
      if (queuedBeforePost) removePendingPublish(template, pubkey);
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
    if (!queuedBeforePost) {
      enqueuePendingPublish(template, pubkey, lastError instanceof Error ? lastError.message : String(lastError));
    }
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
    eventId: signed.id,
    relays: [config.deepmarksRelay],
  };
}

/**
 * Bookmark mutations should become durable once the event itself has
 * been signed. After that point, /publish or NIP-98 transport failures
 * are retry-queue concerns, not user-facing save failures.
 */
export async function publishEventQueued(
  template: UnsignedEventTemplate,
  pubkey: string,
  options: Omit<PublishEventOptions, 'queueBeforePost'> = {},
): Promise<PublishResult> {
  const signed = await signEventTemplate(template, pubkey);
  const queued = enqueuePendingPublish(template, pubkey, 'queued before network publish');

  if (!queued) {
    // Preserve the old fallback semantics: if durable queue storage is
    // unavailable, try the immediate network publish and surface any failure.
    return postSignedEventToApi(signed, template, pubkey, options, false);
  }

  options.onReadyToPost?.(signed);
  void postSignedEventToApi(signed, template, pubkey, options, true).catch((error) => {
    console.warn('Deepmarks queued publish will retry later:', error);
  });

  return { eventId: signed.id, relays: [] };
}

export async function signEventTemplate(
  template: UnsignedEventTemplate,
  pubkey: string,
): Promise<SignedPublishEvent> {
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

  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at!,
    kind: event.kind!,
    tags: event.tags,
    content: event.content,
    sig: event.sig!,
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

export function formatPublishHttpError(status: number, body: string, subject = 'bookmark'): string {
  const detail = parsePublishErrorDetail(body);
  const label = cleanFailureSubject(subject);
  if (status === 401 || status === 403) {
    return 'Deepmarks could not publish because your signer session expired. Reconnect your signer and try again.';
  }
  if (status === 429) {
    return 'Deepmarks is receiving too many publish requests. Wait a moment and try again.';
  }
  if (status === 503) {
    return `Deepmarks publish queue is temporarily unavailable. This ${label} was saved on this device and will retry automatically.`;
  }
  if (status >= 500) {
    return `Deepmarks could not sync this ${label} right now. It was saved on this device and will retry automatically.`;
  }
  if (status === 400) {
    return detail
      ? `Deepmarks could not publish this ${label}: ${detail}`
      : `Deepmarks could not publish this ${label} because the request was invalid.`;
  }
  return detail
    ? `Deepmarks could not publish this ${label}: ${detail}`
    : `Deepmarks could not publish this ${label} right now.`;
}

function cleanFailureSubject(subject: string): string {
  const clean = subject.trim().replace(/\s+/g, ' ').toLowerCase();
  return clean || 'item';
}

function parsePublishErrorDetail(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  let rawDetail = '';
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      rawDetail = stringValue(record.message) || stringValue(record.error) || stringValue(record.detail);
    } else if (typeof parsed === 'string') {
      rawDetail = parsed;
    }
  } catch {
    rawDetail = trimmed;
  }
  const detail = rawDetail.trim().replace(/\s+/g, ' ').slice(0, 160);
  if (!detail || isGenericServerDetail(detail)) return '';
  return detail;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isGenericServerDetail(detail: string): boolean {
  return /^(internal error|internal server error|server error|unknown error)$/i.test(detail.trim());
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
