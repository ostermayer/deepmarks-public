// Publish helpers — wraps NDKEvent so the rest of the app doesn't have to
// know about NDK internals. All publishes go through the shared NDK pool,
// which targets relay.deepmarks.org plus the user's NIP-65 set once loaded.

import { NDKEvent, NDKRelaySet, type NDKRelay } from '@nostr-dev-kit/ndk';
import { get } from 'svelte/store';
import { getNdk } from './ndk.js';
import type { UnsignedEventTemplate } from './bookmarks.js';
import { config } from '$lib/config.js';
import { KIND } from './kinds.js';
import { isNativeShell } from '$lib/native/runtime';
import { userSettings, type RelayConfig } from '$lib/stores/user-settings';
import { enqueuePendingPublish, setPendingPublishImpl } from './pending-publish.js';

export interface PublishResult {
  eventId: string;
  relays: string[];
  warning?: string;
}

// Native WKWebView WebSocket cold-starts can take 5–8s before the first
// relay acks. The web shell is usually warmer (long-lived tab, often
// already connected) so a tighter cap is fine there. Picking a generous
// cap on native trades a slower failure path for far fewer phantom
// "saved on device but never reached relays" gaps that show up as
// bookmarks visible on the phone but missing on /app/bookmarks in the
// browser.
const PUBLISH_TIMEOUT_WEB_MS = 4500;
const PUBLISH_TIMEOUT_NATIVE_MS = 12_000;
const INGEST_TIMEOUT_MS = 3500;

function publishTimeoutMs(): number {
  return isNativeShell() ? PUBLISH_TIMEOUT_NATIVE_MS : PUBLISH_TIMEOUT_WEB_MS;
}

/**
 * Replaceable kinds — addressable parameterized replaceable per NIP-01 — live
 * in [30000, 40000). We treat them as addressable when they carry a `d` tag.
 * Exposed for testing.
 */
export function isParameterizedReplaceable(template: UnsignedEventTemplate): boolean {
  if (template.kind < 30000 || template.kind >= 40000) return false;
  return template.tags.some((t) => t[0] === 'd' && typeof t[1] === 'string');
}

export function relayUrlsForPublish(relays: RelayConfig[] = get(userSettings).relays): string[] {
  return Array.from(new Set([
    config.deepmarksRelay,
    ...relays.filter((r) => r.write).map((r) => r.url),
  ]));
}

export function relaySetForPublish(ndk = getNdk()): NDKRelaySet {
  return NDKRelaySet.fromRelayUrls(relayUrlsForPublish(), ndk, true);
}

export async function publishEvent(
  template: UnsignedEventTemplate,
  pubkey: string
): Promise<PublishResult> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('No signer attached. Sign in first.');

  const event = new NDKEvent(ndk, {
    kind: template.kind,
    pubkey,
    created_at: template.created_at,
    tags: template.tags,
    content: template.content
  });

  const relaySet = relaySetForPublish(ndk);
  const timeoutMs = publishTimeoutMs();
  let accepted: Set<NDKRelay>;
  let warning: string | undefined;
  let publishError: unknown;
  try {
    accepted = isParameterizedReplaceable(template)
      ? await event.publishReplaceable(relaySet, timeoutMs)
      : await event.publish(relaySet, timeoutMs);
  } catch (error) {
    const partial = publishErrorRelays(error);
    if (!partial) {
      // Hard failure (signer error, network blowup) — enqueue for the
      // background drainer to retry instead of dropping on the floor.
      enqueuePendingPublish(template, pubkey, error instanceof Error ? error.message : String(error));
      throw error;
    }
    accepted = partial;
    publishError = error;
    warning = accepted.size > 0
      ? 'not every relay confirmed the save before timeout'
      : 'no relay confirmed the save before timeout';
  }

  // Zero relays acked. The event is signed and valid locally, but
  // no relay has it; without a retry queue this is exactly the
  // "bookmark visible in app but missing on web" gap. Enqueue so the
  // next drain pass tries again.
  if (accepted.size === 0) {
    enqueuePendingPublish(
      template,
      pubkey,
      publishError instanceof Error ? publishError.message : warning,
    );
  } else if (!acceptedSetContains(accepted, config.deepmarksRelay)) {
    // Other relays accepted but relay.deepmarks.org didn't. That's
    // the canonical "did this save become visible on the web?" relay,
    // so treat its miss as a soft failure: report success to the
    // caller (some relay has it), but enqueue a retry so the
    // Deepmarks relay catches up. Without this, saves can land on
    // nos.lol or primal but never on relay.deepmarks.org, and the
    // web view (which leans on Deepmarks-relay reads) never shows
    // them.
    enqueuePendingPublish(
      template,
      pubkey,
      'relay.deepmarks.org did not confirm before timeout',
    );
    warning = warning ?? 'Deepmarks relay didn\'t confirm yet — retrying in background';
  }

  if (template.kind === KIND.webBookmark) {
    await notifyPublicBookmarkIngest(event.rawEvent()).catch((err) => {
      console.warn('Deepmarks bookmark ingest failed:', err);
    });
  }

  return {
    eventId: event.id,
    relays: Array.from(accepted).map((r) => r.url),
    warning,
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

function publishErrorRelays(error: unknown): Set<NDKRelay> | null {
  if (!error || typeof error !== 'object') return null;
  const relays = (error as { publishedToRelays?: unknown }).publishedToRelays;
  return relays instanceof Set ? relays as Set<NDKRelay> : null;
}

/** Tolerates trailing slashes and `wss://`/`ws://` mismatches when
 *  asking whether a given URL is in the accepted set. NDK normalizes
 *  relay URLs in subtly different ways across versions, so equality
 *  checks against `relay.url` can miss the deepmarks relay. */
function acceptedSetContains(accepted: Set<NDKRelay>, target: string): boolean {
  const wanted = target.replace(/\/$/, '');
  for (const relay of accepted) {
    if (relay.url.replace(/\/$/, '') === wanted) return true;
  }
  return false;
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
