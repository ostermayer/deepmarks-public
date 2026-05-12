// Publish helpers — wraps NDKEvent so the rest of the app doesn't have to
// know about NDK internals. All publishes go through the shared NDK pool,
// which targets relay.deepmarks.org plus the user's NIP-65 set once loaded.

import { NDKEvent, NDKRelaySet } from '@nostr-dev-kit/ndk';
import { get } from 'svelte/store';
import { getNdk } from './ndk.js';
import type { UnsignedEventTemplate } from './bookmarks.js';
import { config } from '$lib/config.js';
import { KIND } from './kinds.js';
import { userSettings, type RelayConfig } from '$lib/stores/user-settings';

export interface PublishResult {
  eventId: string;
  relays: string[];
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
  const accepted = isParameterizedReplaceable(template)
    ? await event.publishReplaceable(relaySet)
    : await event.publish(relaySet);

  if (template.kind === KIND.webBookmark) {
    await notifyPublicBookmarkIngest(event.rawEvent()).catch((err) => {
      console.warn('Deepmarks bookmark ingest failed:', err);
    });
  }

  return {
    eventId: event.id,
    relays: Array.from(accepted).map((r) => r.url)
  };
}

async function notifyPublicBookmarkIngest(event: unknown): Promise<void> {
  const res = await fetch(`${config.apiBase}/bookmarks/public`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text().catch(() => '')}`);
  }
}
