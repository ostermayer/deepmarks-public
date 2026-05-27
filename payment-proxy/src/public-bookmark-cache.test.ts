import { describe, expect, it } from 'vitest';
import type { Event as NostrEvent } from 'nostr-tools';
import {
  cachePublicBookmarkEvent,
  listCachedPublicBookmarks,
  removeCachedPublicBookmarksForDeletion,
} from './public-bookmark-cache.js';

class FakeRedis {
  strings = new Map<string, string>();
  zsets = new Map<string, Map<string, number>>();
  sets = new Map<string, Set<string>>();
  lists = new Map<string, string[]>();

  multi(): { set: (key: string, value: string) => unknown; zadd: (key: string, score: number, id: string) => unknown; zremrangebyrank: () => unknown; zrem: (key: string, id: string) => unknown; del: (key: string) => unknown; exec: () => Promise<unknown[]> } {
    const ops: Array<() => void> = [];
    const tx = {
      set: (key: string, value: string) => { ops.push(() => this.strings.set(key, value)); return tx; },
      zadd: (key: string, score: number, id: string) => {
        ops.push(() => {
          const zset = this.zsets.get(key) ?? new Map<string, number>();
          zset.set(id, score);
          this.zsets.set(key, zset);
        });
        return tx;
      },
      zremrangebyrank: () => tx,
      zrem: (key: string, id: string) => { ops.push(() => this.zsets.get(key)?.delete(id)); return tx; },
      del: (key: string) => { ops.push(() => this.strings.delete(key)); return tx; },
      exec: async () => { ops.forEach((op) => op()); return []; },
    };
    return tx;
  }

  async mget(keys: string[]): Promise<Array<string | null>> {
    return keys.map((key) => this.strings.get(key) ?? null);
  }

  async zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    return [...(this.zsets.get(key) ?? new Map()).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(start, stop + 1)
      .map(([id]) => id);
  }

  async sadd(key: string, value: string): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    const before = set.size;
    set.add(value);
    this.sets.set(key, set);
    return set.size === before ? 0 : 1;
  }

  async lpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }
}

function bookmark(overrides: Partial<NostrEvent>): NostrEvent {
  return {
    id: 'b'.repeat(64),
    pubkey: 'a'.repeat(64),
    created_at: 10,
    kind: 39701,
    tags: [['d', 'https://example.com'], ['title', 'Example']],
    content: '',
    sig: 'f'.repeat(128),
    ...overrides,
  };
}

describe('public bookmark cache deletion', () => {
  it('removes cached kind:39701 rows targeted by kind:5', async () => {
    const redis = new FakeRedis();
    const event = bookmark({});
    await cachePublicBookmarkEvent(redis as never, event);
    await expect(listCachedPublicBookmarks(redis as never, event.pubkey, 10)).resolves.toHaveLength(1);

    const removed = await removeCachedPublicBookmarksForDeletion(redis as never, {
      ...bookmark({
        id: 'd'.repeat(64),
        kind: 5,
        created_at: 11,
        tags: [
          ['e', event.id],
          ['a', `39701:${event.pubkey}:https://example.com`],
        ],
      }),
    });

    expect(removed).toEqual([event.id]);
    await expect(listCachedPublicBookmarks(redis as never, event.pubkey, 10)).resolves.toEqual([]);
  });

  it('does not let one author remove another author from cache by e-tag', async () => {
    const redis = new FakeRedis();
    const owner = 'a'.repeat(64);
    const attacker = 'c'.repeat(64);
    const event = bookmark({ pubkey: owner });
    await cachePublicBookmarkEvent(redis as never, event);

    const removed = await removeCachedPublicBookmarksForDeletion(redis as never, {
      ...bookmark({
        id: 'd'.repeat(64),
        pubkey: attacker,
        kind: 5,
        created_at: 11,
        tags: [['e', event.id]],
      }),
    });

    expect(removed).toEqual([]);
    await expect(listCachedPublicBookmarks(redis as never, owner, 10)).resolves.toHaveLength(1);
  });
});
