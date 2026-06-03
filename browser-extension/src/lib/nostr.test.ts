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
  publishBookmark,
  publishSignedEventDirect,
} from './nostr.js';
import { pendingPublishCount } from './pending-publish.js';

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

describe('server-mediated publish retry queue', () => {
  function installChromeStorage(initial: Record<string, unknown> = {}) {
    const storage = new Map<string, unknown>(Object.entries(initial));
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
          set: vi.fn(async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) storage.set(key, value);
          }),
          remove: vi.fn(async (key: string) => {
            storage.delete(key);
          }),
        },
      },
    } as unknown as typeof chrome;
  }

  it('queues a signed bookmark and reports accepted when /publish is unavailable', async () => {
    installChromeStorage();
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => 'publish queue unavailable',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishBookmark({
      url: 'https://queued.example',
      title: 'Queued',
      tags: [],
    }, '1'.repeat(64));

    expect(result.ok).toEqual(['wss://relay.deepmarks.org']);
    expect(result.failed).toEqual([]);
    await expect(pendingPublishCount(result.event.pubkey)).resolves.toBe(1);
  });

  it('removes the queued copy after /publish accepts the event', async () => {
    installChromeStorage();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 202,
      text: async () => '',
    })));

    const result = await publishBookmark({
      url: 'https://accepted.example',
      title: 'Accepted',
      tags: [],
    }, '1'.repeat(64));

    expect(result.ok).toEqual(['wss://relay.deepmarks.org']);
    await expect(pendingPublishCount(result.event.pubkey)).resolves.toBe(0);
  });

  it('queues direct-mode bookmarks when no direct relay accepts them', async () => {
    installChromeStorage({
      'deepmarks-settings': {
        publishMode: 'direct',
        relays: [{ url: 'wss://relay.bad', read: true, write: true }],
      },
    });
    const pool = {
      publish: vi.fn((relays: string[]) => relays.map(() => Promise.reject(new Error('offline')))),
    };

    const result = await publishBookmark({
      url: 'https://direct-fallback.example',
      title: 'Direct fallback',
      tags: [],
    }, '1'.repeat(64), pool as never, 100);

    expect(pool.publish).toHaveBeenCalledWith(['wss://relay.bad'], result.event);
    expect(result.ok).toEqual(['wss://relay.deepmarks.org']);
    expect(result.failed).toEqual([]);
    await expect(pendingPublishCount(result.event.pubkey)).resolves.toBe(1);
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
