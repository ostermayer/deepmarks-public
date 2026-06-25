// Compute a display-ready tag cloud from a set of bookmarks. Pure.
//
// We group into 5 frequency buckets (s1..s5) matching the CSS sizing
// classes in the sidebar. Buckets are allocated by count, not by rank:
// equal counts must render at equal sizes.

import type { ParsedBookmark } from './bookmarks.js';
import { bookmarkZapSats } from './bookmark-zap-target.js';
import type { ZapAggregate } from './popularity.js';

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

export interface TagZapCount {
  name: string;
  count: number;
  zapSats: number;
}

export function countTagsWithZapSats(
  bookmarks: ParsedBookmark[],
  zapDataByEventId: Map<string, ZapAggregate> | null | undefined,
): TagZapCount[] {
  const counts = new Map<string, { count: number; zapSats: number }>();
  for (const bookmark of bookmarks) {
    const zapSats = bookmarkZapSats(bookmark, zapDataByEventId);
    for (const tag of bookmark.tags) {
      const key = tag.trim().toLowerCase();
      if (!key) continue;
      const current = counts.get(key);
      if (current) {
        current.count += 1;
        current.zapSats += zapSats;
      } else {
        counts.set(key, { count: 1, zapSats });
      }
    }
  }
  return Array.from(counts, ([name, value]) => ({ name, ...value })).sort(
    (a, b) => b.zapSats - a.zapSats || b.count - a.count || a.name.localeCompare(b.name),
  );
}

/**
 * Turn a raw count list into count-bucketed cloud items.
 * The biggest count maps to s5, the smallest maps to s1, and ties map
 * to the same size. A flat population maps to s3 so equal one-count
 * tags don't get artificial size differences.
 */
export function bucketize(counts: { name: string; count: number }[]): TagCloudItem[] {
  const n = counts.length;
  if (n === 0) return [];
  if (n === 1) return [{ name: counts[0]!.name, weight: 3 }];
  const values = counts.map((c) => c.count);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return counts.map(({ name }) => ({ name, weight: 3 }));

  return counts.map(({ name, count }) => {
    const normalized = (count - min) / (max - min);
    const weight = Math.round(1 + normalized * 4) as 1 | 2 | 3 | 4 | 5;
    return { name, weight };
  });
}

/** Convenience: bookmarks → cloud, one call. */
export function tagCloudFrom(bookmarks: ParsedBookmark[], limit = 24): TagCloudItem[] {
  return bucketize(countTags(bookmarks).slice(0, limit));
}
