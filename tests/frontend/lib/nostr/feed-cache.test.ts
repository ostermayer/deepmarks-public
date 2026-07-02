import { beforeEach, describe, expect, it } from 'vitest';
import type { ParsedBookmark } from '$lib/nostr/bookmarks';
import { cachedBookmarkFeedSnapshot, saveCachedBookmarkFeed } from '$lib/nostr/feed-cache';

class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number { return this.store.size; }
  key(i: number): string | null {
    return [...this.store.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.store.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, String(v));
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

const memStorage = new MemoryStorage();
(globalThis as unknown as { localStorage: Storage }).localStorage = memStorage as unknown as Storage;

function bookmark(id: string, url = `https://example.com/${id}`): ParsedBookmark {
  return {
    url,
    title: id,
    description: '',
    tags: [],
    archivedForever: false,
    savedAt: 1,
    curator: 'pubkey',
    eventId: id,
  };
}

beforeEach(() => {
  memStorage.clear();
});

describe('feed-cache', () => {
  it('loads the exact cache key when present', () => {
    saveCachedBookmarkFeed({ authors: ['b'], limit: 200 }, [bookmark('exact')]);
    saveCachedBookmarkFeed({ authors: ['b'], limit: 100 }, [bookmark('fallback')]);

    expect(cachedBookmarkFeedSnapshot({ authors: ['b'], limit: 200 })).toEqual([bookmark('exact')]);
  });

  it('falls back to a same-query cache with a different limit', () => {
    saveCachedBookmarkFeed({ authors: ['b'], limit: 100 }, [bookmark('one'), bookmark('two')]);

    expect(cachedBookmarkFeedSnapshot({ authors: ['b'], limit: 200 })).toEqual([
      bookmark('one'),
      bookmark('two'),
    ]);
  });

  it('does not cross author/tag/url cache boundaries during fallback', () => {
    saveCachedBookmarkFeed({ authors: ['a'], limit: 100 }, [bookmark('wrong-author')]);
    saveCachedBookmarkFeed({ authors: ['b'], tags: ['nostr'], limit: 100 }, [bookmark('wrong-tag')]);
    saveCachedBookmarkFeed({ authors: ['b'], limit: 100 }, [bookmark('right')]);

    expect(cachedBookmarkFeedSnapshot({ authors: ['b'], limit: 500 })).toEqual([bookmark('right')]);
  });
});
