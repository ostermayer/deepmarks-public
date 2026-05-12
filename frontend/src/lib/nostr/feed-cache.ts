import type { ParsedBookmark } from './bookmarks.js';
import type { FeedOptions } from './feed-types.js';

// Synchronous localStorage feed cache. Kept separate from feed.ts so
// first-paint surfaces can read cached rows without importing NDK.
const LS_PREFIX = 'deepmarks-feed-cache:v2:';
const LS_MAX_ENTRIES = 200;

function lsKey(opts: FeedOptions): string {
  return LS_PREFIX + JSON.stringify({
    a: opts.authors ? [...opts.authors].sort() : null,
    t: opts.tags ? [...opts.tags].sort() : null,
    u: opts.urls ? [...opts.urls].sort() : null,
    l: opts.limit ?? 200,
  });
}

export function loadCachedBookmarkFeed(opts: FeedOptions = {}): ParsedBookmark[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(lsKey(opts));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ParsedBookmark[]) : [];
  } catch {
    return [];
  }
}

export function saveCachedBookmarkFeed(opts: FeedOptions, list: ParsedBookmark[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(lsKey(opts), JSON.stringify(list.slice(0, LS_MAX_ENTRIES)));
  } catch {
    // Quota / private mode: the NDK cache still has the data.
  }
}

/** Synchronous localStorage snapshot for surfaces that need a first-paint
 *  cache without starting NDK/Dexie/relay work during component init. */
export function cachedBookmarkFeedSnapshot(opts: FeedOptions = {}): ParsedBookmark[] {
  return loadCachedBookmarkFeed(opts);
}
