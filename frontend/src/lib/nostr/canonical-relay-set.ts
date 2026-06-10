// Build the canonical read-relay set for fetching the user's own
// addressable events (private bookmarks, archive-keys set, etc).
//
// NDK's default outbox routing reads from the author's NIP-65 advertised
// write relays. relay.deepmarks.org is usually not in that list, so the
// canonical Deepmarks store gets skipped even though it's the source of
// truth — the user's private chunks may live only on Deepmarks while
// their NIP-65 list points at nos.lol / primal / damus / etc. Two
// callers (fetchOwnPrivateSetEvents and getArchiveKeyMap) used to
// hand-roll the same union; this is the one source of truth.
//
// Set composition:
//   - relay.deepmarks.org (always; the operator-managed source-of-truth relay)
//   - every relay in the user's active Deepmarks list that has read or write
//   - any extras the caller passes in (typically the NIP-65 advertised
//     list, loaded async via getRelayList)

import { get } from 'svelte/store';
import { NDKRelaySet } from '@nostr-dev-kit/ndk';
import { config } from '$lib/config';
import { userSettings } from '$lib/stores/user-settings';
import { ensureRelayUrlsConnected, getNdk } from './ndk.js';

/**
 * Return the URL list for the canonical read-relay set. Pure — does
 * no I/O. Pass `extraRelays` for the user's NIP-65 advertised list (or
 * anything else you know about).
 */
export function canonicalRelayUrls(extraRelays: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (url: string | undefined): void => {
    if (!url) return;
    const trimmed = url.replace(/\/$/, '');
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  push(config.deepmarksRelay);
  for (const relay of get(userSettings).relays) {
    if (relay.read || relay.write) push(relay.url);
  }
  for (const url of extraRelays) push(url);
  return out;
}

/**
 * Build an explicit NDKRelaySet covering the canonical relay URLs.
 * Returns null in test environments where the NDK pool isn't ready —
 * callers should fall back to NDK's default outbox routing in that case.
 */
export function canonicalRelaySet(extraRelays: readonly string[] = []): NDKRelaySet | null {
  const urls = canonicalRelayUrls(extraRelays);
  try {
    ensureRelayUrlsConnected(urls);
  } catch {
    // Test stubs may not implement ensureRelayUrlsConnected.
  }
  try {
    return NDKRelaySet.fromRelayUrls(urls, getNdk(), true);
  } catch {
    // Pool not initialized — let caller fall through.
    return null;
  }
}
