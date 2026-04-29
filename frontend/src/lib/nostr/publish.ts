// Publish helpers — wraps NDKEvent so the rest of the app doesn't have to
// know about NDK internals. All publishes go through the shared NDK pool,
// which targets relay.deepmarks.org plus the user's NIP-65 set once loaded.

import { NDKEvent } from '@nostr-dev-kit/ndk';
import { getNdk } from './ndk.js';
import type { UnsignedEventTemplate } from './bookmarks.js';

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

  const accepted = isParameterizedReplaceable(template)
    ? await event.publishReplaceable()
    : await event.publish();

  return {
    eventId: event.id,
    relays: Array.from(accepted).map((r) => r.url)
  };
}
