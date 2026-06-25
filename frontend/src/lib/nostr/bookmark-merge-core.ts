// PARITY-COPIED FILE — byte-identical between
// frontend/src/lib/nostr/bookmark-merge-core.ts and
// browser-extension/src/lib/bookmark-merge-core.ts, guarded by
// tests/frontend/regression/shared-core-parity.test.ts.
//
// THE canonical "which copy of this replaceable bookmark wins" rule —
// one answer shared by the web feed, the own-bookmarks store, and the
// extension popup merge. Three implementations of this policy once
// drifted apart (different tie-break directions); every surface now
// delegates here.

/** The fields the merge rule reads. Both surfaces' parsed-bookmark
 *  shapes satisfy this structurally. */
export interface MergeableBookmark {
  url: string;
  savedAt: number;
  savedAtMs?: number;
  publishedAt?: number;
  eventCreatedAt?: number;
  eventId: string;
}

export function bookmarkSortTimeMs(bookmark: MergeableBookmark): number {
  return bookmark.savedAtMs ?? bookmark.savedAt * 1000;
}

/**
 * Tiers:
 *   0. a real event beats an optimistic placeholder at equal save time
 *      (web-only `optimistic:` ids; extension optimistic rows are
 *      spliced in by URL and never reach this rule)
 *   1. newer replace-time (eventCreatedAt ?? savedAt) wins
 *   2. newer millisecond-resolution save time wins
 *   3. newer savedAt wins
 *   4. NIP-01 relay retention: the LOWEST event id wins — the relay
 *      keeps that copy, so every device must pick the same winner
 */
export function replaceableBookmarkWins(
  existing: MergeableBookmark,
  incoming: MergeableBookmark,
): boolean {
  if (
    existing.savedAt === incoming.savedAt &&
    existing.eventId.startsWith('optimistic:') &&
    !incoming.eventId.startsWith('optimistic:')
  ) {
    return true;
  }
  const incomingReplaceTime = incoming.eventCreatedAt ?? incoming.savedAt;
  const existingReplaceTime = existing.eventCreatedAt ?? existing.savedAt;
  if (incomingReplaceTime > existingReplaceTime) return true;
  if (incomingReplaceTime < existingReplaceTime) return false;
  const incomingMs = bookmarkSortTimeMs(incoming);
  const existingMs = bookmarkSortTimeMs(existing);
  if (incomingMs > existingMs) return true;
  if (incomingMs < existingMs) return false;
  if (incoming.savedAt > existing.savedAt) return true;
  if (incoming.savedAt < existing.savedAt) return false;
  // Equal ids = the same event re-delivered (cache + relay): not a
  // replace. Otherwise the LOWEST id wins, per NIP-01 retention.
  return incoming.eventId < existing.eventId;
}

/** Companion to replaceableBookmarkWins: when the incoming copy wins
 *  but lacks save-time provenance the existing copy carries, keep the
 *  existing timestamps so edits don't jump to the top of chronological
 *  views (or lose same-second ordering). */
export function mergeReplaceableBookmark<T extends MergeableBookmark>(
  existing: T | undefined,
  incoming: T,
): T {
  if (existing && incoming.publishedAt === undefined && existing.savedAt < incoming.savedAt) {
    return {
      ...incoming,
      publishedAt: existing.publishedAt,
      savedAt: existing.savedAt,
      savedAtMs: existing.savedAtMs,
    };
  }
  if (existing?.savedAtMs && !incoming.savedAtMs && existing.savedAt === incoming.savedAt) {
    return { ...incoming, savedAtMs: existing.savedAtMs };
  }
  return incoming;
}

export function compareBookmarksNewest(a: MergeableBookmark, b: MergeableBookmark): number {
  const time = bookmarkSortTimeMs(b) - bookmarkSortTimeMs(a);
  if (time !== 0) return time;
  const seconds = b.savedAt - a.savedAt;
  if (seconds !== 0) return seconds;
  const ids = b.eventId.localeCompare(a.eventId);
  if (ids !== 0) return ids;
  return a.url.localeCompare(b.url);
}

export function compareBookmarksOldest(a: MergeableBookmark, b: MergeableBookmark): number {
  return compareBookmarksNewest(b, a);
}
