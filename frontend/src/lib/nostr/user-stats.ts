// Derive the "your marks" sidebar stats from a user's own bookmarks.
// Pure — no store access. Callers wire this into a reactive derivation
// over the live feed.

import type { ParsedBookmark } from './bookmarks.js';

export interface UserStats {
  marked: number;
  archivedForever: number;
  tagsUsed: number;
  /** Sats sent in zaps (requires external tracking — stubbed until wired). */
  satsSent: number | null;
  /** Sats received (ditto). */
  satsReceived: number | null;
}

export function userStatsFrom(bookmarks: ParsedBookmark[]): UserStats {
  const tags = new Set<string>();
  let archived = 0;
  for (const b of bookmarks) {
    if (b.archivedForever) archived++;
    for (const t of b.tags) {
      const key = t.trim().toLowerCase();
      if (key) tags.add(key);
    }
  }
  return {
    marked: bookmarks.length,
    archivedForever: archived,
    tagsUsed: tags.size,
    // Real sat totals come from the payment-proxy's SaveCountTracker /
    // ZapReceiptListener aggregation + user session JWT — not derivable
    // from the raw bookmark list alone.
    satsSent: null,
    satsReceived: null,
  };
}
