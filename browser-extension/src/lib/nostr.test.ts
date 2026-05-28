import { describe, expect, it, vi } from 'vitest';
import {
  buildBookmarkTemplate,
  buildSocialPostTemplate,
  discoverUserRelays,
  fetchBookmarks,
  filterDeletedBookmarkEvents,
  KIND_BOOKMARK,
  KIND_DELETION,
  KIND_NOTE,
  KIND_RELAY_LIST,
  publishSignedEventDirect,
} from './nostr.js';

describe('buildSocialPostTemplate', () => {
  it('builds a top-level note instead of a reply', () => {
    const event = buildSocialPostTemplate({
      url: 'https://example.com',
      title: 'Example',
      bookmarkEventId: 'b'.repeat(64),
      bookmarkAuthor: 'a'.repeat(64),
    });

    expect(event.kind).toBe(KIND_NOTE);
    expect(event.tags).toContainEqual(['r', 'https://example.com']);
    expect(event.tags.find((tag) => tag[0] === 'e')).toBeUndefined();
    expect(event.tags).toContainEqual(['a', `39701:${'a'.repeat(64)}:https://example.com`]);
  });
});

describe('buildBookmarkTemplate', () => {
  it('includes published_at_ms when it matches published_at', () => {
    const event = buildBookmarkTemplate({
      url: 'https://example.com',
      title: 'Example',
      tags: [],
      publishedAt: 1_700_000_000,
      publishedAtMs: 1_700_000_000_123,
    });

    expect(event.tags).toContainEqual(['published_at', '1700000000']);
    expect(event.tags).toContainEqual(['published_at_ms', '1700000000123']);
  });
});

describe('discoverUserRelays', () => {
  it('uses the published NIP-65 relay list without historical event-relay fallback', async () => {
    const pool = {
      querySync: vi.fn(async (relays: string[], filter: { kinds?: number[] }) => {
        if (relays.length > 1 && filter.kinds?.[0] === KIND_RELAY_LIST) {
          return [{
            created_at: 2,
            tags: [['r', 'wss://custom.example/', 'read']],
          }];
        }
        if (relays[0] === 'wss://nos.lol') {
          return [{ created_at: 1, tags: [] }];
        }
        return [];
      }),
    };

    const relays = await discoverUserRelays(
      'p'.repeat(64),
      pool as never,
      ['wss://nos.lol', 'wss://custom.example'],
    );

    expect(relays).toEqual([
      { url: 'wss://custom.example', read: true, write: false },
    ]);
  });
});

describe('publishSignedEventDirect', () => {
  it('publishes to each unique relay and reports failures', async () => {
    const event = { id: 'e'.repeat(64) };
    const pool = {
      publish: vi.fn((relays: string[]) => relays.map((relay) => (
        relay.includes('bad')
          ? Promise.reject(new Error('blocked by relay'))
          : Promise.resolve('ok')
      ))),
    };

    const result = await publishSignedEventDirect(
      event as never,
      ['wss://relay.good', 'wss://relay.good', 'wss://relay.bad'],
      pool as never,
      100,
    );

    expect(pool.publish).toHaveBeenCalledWith(['wss://relay.good', 'wss://relay.bad'], event);
    expect(result.ok).toEqual(['wss://relay.good']);
    expect(result.failed).toEqual([{ url: 'wss://relay.bad', reason: 'blocked by relay' }]);
  });
});

describe('filterDeletedBookmarkEvents', () => {
  function event(overrides: Partial<{
    id: string;
    kind: number;
    pubkey: string;
    created_at: number;
    tags: string[][];
    content: string;
    sig: string;
  }>) {
    return {
      id: overrides.id ?? 'e'.repeat(64),
      kind: overrides.kind ?? KIND_BOOKMARK,
      pubkey: overrides.pubkey ?? 'a'.repeat(64),
      created_at: overrides.created_at ?? 1,
      tags: overrides.tags ?? [],
      content: overrides.content ?? '',
      sig: overrides.sig ?? 'f'.repeat(128),
    };
  }

  it('removes bookmarks targeted by a newer deletion event', () => {
    const pubkey = 'a'.repeat(64);
    const url = 'https://example.com';
    const bookmark = event({
      id: 'b'.repeat(64),
      pubkey,
      created_at: 10,
      tags: [['d', url], ['title', 'Example']],
    });
    const deletion = event({
      id: 'd'.repeat(64),
      kind: KIND_DELETION,
      pubkey,
      created_at: 11,
      tags: [['a', `${KIND_BOOKMARK}:${pubkey}:${url}`]],
    });

    expect(filterDeletedBookmarkEvents([bookmark, deletion])).toEqual([]);
  });

  it('keeps a newer replacement after an older deletion', () => {
    const pubkey = 'a'.repeat(64);
    const url = 'https://example.com';
    const deletion = event({
      id: 'd'.repeat(64),
      kind: KIND_DELETION,
      pubkey,
      created_at: 10,
      tags: [['a', `${KIND_BOOKMARK}:${pubkey}:${url}`]],
    });
    const replacement = event({
      id: 'c'.repeat(64),
      pubkey,
      created_at: 12,
      tags: [['d', url], ['title', 'Replacement']],
    });

    expect(filterDeletedBookmarkEvents([deletion, replacement])).toEqual([replacement]);
  });

  it('orders same-second bookmarks by published_at_ms', async () => {
    globalThis.chrome = {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    } as unknown as typeof chrome;
    const pubkey = 'a'.repeat(64);
    const older = event({
      id: '1'.repeat(64),
      pubkey,
      created_at: 20,
      tags: [
        ['d', 'https://example.com/older'],
        ['published_at', '20'],
        ['published_at_ms', '20001'],
      ],
    });
    const newer = event({
      id: '2'.repeat(64),
      pubkey,
      created_at: 20,
      tags: [
        ['d', 'https://example.com/newer'],
        ['published_at', '20'],
        ['published_at_ms', '20002'],
      ],
    });
    const pool = {
      querySync: vi.fn(async () => [older, newer]),
    };

    const result = await fetchBookmarks([pubkey], 10, pool as never);

    expect(result.map((e) => e.tags.find((tag) => tag[0] === 'd')?.[1])).toEqual([
      'https://example.com/newer',
      'https://example.com/older',
    ]);
  });
});
