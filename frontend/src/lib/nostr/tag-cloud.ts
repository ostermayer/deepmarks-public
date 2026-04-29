// Compute a display-ready tag cloud from a set of bookmarks. Pure.
//
// We group into 5 frequency buckets (s1..s5) matching the CSS sizing
// classes in the sidebar. Buckets are allocated by rank so the visual
// distribution is even — a flat population with lots of 1-count tags
// would otherwise collapse to all-s1.

import type { ParsedBookmark } from './bookmarks.js';

export interface TagCloudItem {
  name: string;
  /** 1–5; 5 is the largest / most-used. */
  weight: 1 | 2 | 3 | 4 | 5;
}

/** Aggregate bookmark tags → [{name, count}] sorted by count desc. */
export function countTags(bookmarks: ParsedBookmark[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const b of bookmarks) {
    for (const t of b.tags) {
      const key = t.trim().toLowerCase();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return Array.from(counts, ([name, count]) => ({ name, count })).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
}

/**
 * Turn a raw count list into rank-bucketed cloud items.
 *
 * Buckets are allocated by position in the sorted list:
 *   top 10% → s5, next 20% → s4, next 30% → s3, next 25% → s2, rest → s1.
 * Edge cases (1-3 tags) collapse sanely: singleton → s3, pair → [s4, s2], etc.
 */
export function bucketize(counts: { name: string; count: number }[]): TagCloudItem[] {
  const n = counts.length;
  if (n === 0) return [];
  if (n === 1) return [{ name: counts[0]!.name, weight: 3 }];
  return counts.map(({ name }, i) => {
    const pct = i / (n - 1); // 0 for most popular, 1 for least
    const weight: 1 | 2 | 3 | 4 | 5 =
      pct <= 0.1 ? 5 :
      pct <= 0.3 ? 4 :
      pct <= 0.6 ? 3 :
      pct <= 0.85 ? 2 :
      1;
    return { name, weight };
  });
}

/** Convenience: bookmarks → cloud, one call. */
export function tagCloudFrom(bookmarks: ParsedBookmark[], limit = 24): TagCloudItem[] {
  return bucketize(countTags(bookmarks).slice(0, limit));
}
