// Server-side popularity ranking — same shape as the frontend's
// lib/nostr/popularity.ts. Kept as two files deliberately: the frontend
// can't import server code, and the backend shouldn't depend on the
// frontend. Both call sites have their own exhaustive tests.

import type { BookmarkJson } from '../api-helpers.js';

export interface RankedBookmark extends BookmarkJson {
  saveCount: number;
}

export function rankByPopularity(bookmarks: BookmarkJson[]): RankedBookmark[] {
  const byUrl = new Map<string, { rep: BookmarkJson; curators: Set<string> }>();
  for (const b of bookmarks) {
    const slot = byUrl.get(b.url);
    if (!slot) {
      byUrl.set(b.url, { rep: b, curators: new Set([b.pubkey]) });
      continue;
    }
    slot.curators.add(b.pubkey);
    if (
      b.savedAt > slot.rep.savedAt ||
      (b.savedAt === slot.rep.savedAt && b.id > slot.rep.id)
    ) {
      slot.rep = b;
    }
  }
  const ranked: RankedBookmark[] = [];
  for (const { rep, curators } of byUrl.values()) {
    ranked.push({ ...rep, saveCount: curators.size });
  }
  ranked.sort((a, b) => {
    if (b.saveCount !== a.saveCount) return b.saveCount - a.saveCount;
    return b.savedAt - a.savedAt;
  });
  return ranked;
}
