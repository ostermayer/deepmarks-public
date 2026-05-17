import type { ParsedBookmark } from './bookmarks.js';
import type { FeedOptions } from './feed-types.js';

// Synchronous localStorage feed cache. Kept separate from feed.ts so
// first-paint surfaces can read cached rows without importing NDK.
const LS_PREFIX = 'deepmarks-feed-cache:v2:';
const LS_MAX_ENTRIES = 200;

interface CacheKeyParts {
  a: string[] | null;
  t: string[] | null;
  u: string[] | null;
  l: number;
}

function keyParts(opts: FeedOptions): CacheKeyParts {
  return {
    a: opts.authors ? [...opts.authors].sort() : null,
    t: opts.tags ? [...opts.tags].sort() : null,
    u: opts.urls ? [...opts.urls].sort() : null,
    l: opts.limit ?? 200,
  };
}

function lsKey(opts: FeedOptions): string {
  return LS_PREFIX + JSON.stringify(keyParts(opts));
}

function sameFeedQuery(a: CacheKeyParts, b: CacheKeyParts): boolean {
  return JSON.stringify(a.a) === JSON.stringify(b.a) &&
    JSON.stringify(a.t) === JSON.stringify(b.t) &&
    JSON.stringify(a.u) === JSON.stringify(b.u);
}

function parseBookmarks(raw: string | null): ParsedBookmark[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as ParsedBookmark[]) : [];
}

export function loadCachedBookmarkFeed(opts: FeedOptions = {}): ParsedBookmark[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const exact = parseBookmarks(localStorage.getItem(lsKey(opts)));
    if (exact.length > 0) return exact;

    // Older surfaces used different `limit` values for the same feed
    // query, which created separate localStorage keys. Reuse the best
    // same-query cache so /u/<npub> and /app/bookmarks don't disagree
    // after one of them has already warmed the browser.
    const wanted = keyParts(opts);
    let best: ParsedBookmark[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(LS_PREFIX)) continue;
      let parts: CacheKeyParts;
      try {
        parts = JSON.parse(key.slice(LS_PREFIX.length)) as CacheKeyParts;
      } catch {
        continue;
      }
      if (!sameFeedQuery(wanted, parts)) continue;
      const candidate = parseBookmarks(localStorage.getItem(key));
      if (candidate.length > best.length) best = candidate;
    }
    return best;
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
