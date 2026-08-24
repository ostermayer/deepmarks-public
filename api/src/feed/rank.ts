// Server-side popularity ranking — same shape as the frontend's
// lib/nostr/popularity.ts. Kept as two files deliberately: the frontend
// can't import server code, and the backend shouldn't depend on the
// frontend. Both call sites have their own exhaustive tests.

import type { BookmarkJson } from '../api-helpers.js';
import { canonicalizeUrlForIndex } from '../url-index.js';
import { bookmarkSortScore } from '../api-helpers.js';

export interface RankedBookmark extends BookmarkJson {
  saveCount: number;
}

export function rankByPopularity(bookmarks: BookmarkJson[]): RankedBookmark[] {
  const byUrl = new Map<string, { rep: BookmarkJson; curators: Set<string> }>();
  for (const b of bookmarks) {
    // Canonical key — raw-URL grouping split popularity counts across
    // trailing-slash/?utm_* variants of the same page (2026-08-23 #8).
    const urlKey = canonicalizeUrlForIndex(b.url);
    const slot = byUrl.get(urlKey);
    if (!slot) {
      byUrl.set(urlKey, { rep: b, curators: new Set([b.pubkey]) });
      continue;
    }
    slot.curators.add(b.pubkey);
    const incomingEditTime = b.eventCreatedAt ?? b.savedAt;
    const currentEditTime = slot.rep.eventCreatedAt ?? slot.rep.savedAt;
    if (
      bookmarkSortScore(b) > bookmarkSortScore(slot.rep) ||
      (bookmarkSortScore(b) === bookmarkSortScore(slot.rep) && (
        incomingEditTime > currentEditTime ||
        (incomingEditTime === currentEditTime && b.id > slot.rep.id)
      ))
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
    return bookmarkSortScore(b) - bookmarkSortScore(a);
  });
  return ranked;
}
