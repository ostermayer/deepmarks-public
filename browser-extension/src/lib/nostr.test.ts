import { describe, expect, it, vi } from 'vitest';
import {
  buildSocialPostTemplate,
  discoverUserRelays,
  filterDeletedBookmarkEvents,
  KIND_BOOKMARK,
  KIND_DELETION,
  KIND_NOTE,
  KIND_RELAY_LIST,
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

describe('discoverUserRelays', () => {
  it('merges explicit NIP-65 relays with relays that already have user events', async () => {
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

    expect(relays).toEqual(expect.arrayContaining([
      { url: 'wss://nos.lol', read: true, write: true },
      { url: 'wss://custom.example', read: true, write: false },
    ]));
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
});
