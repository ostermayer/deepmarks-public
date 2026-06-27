import { describe, it, expect } from 'vitest';
import {
  buildBookmarkEvent,
  compareBookmarksNewest,
  parseBookmarkEvent,
  type ParsedBookmark
} from '$lib/nostr/bookmarks.js';
import { KIND } from '$lib/nostr/kinds.js';

describe('buildBookmarkEvent', () => {
  it('emits the Deepmarks tag schema for a public bookmark', () => {
    const event = buildBookmarkEvent({
      url: 'https://example.com/x',
      title: 'Example',
      description: 'desc',
      tags: ['bitcoin', 'lightning'],
      publishedAt: 1700000000,
      publishedAtMs: 1700000000123,
      lightning: 'me@getalby.com',
      blossomHash: 'sha256-xyz',
      waybackUrl: 'https://web.archive.org/...',
      archivedForever: true
    });
    expect(event.kind).toBe(KIND.webBookmark);
    expect(event.content).toBe('');
    // Order matters for human readability but we assert by membership.
    const map = Object.fromEntries(event.tags.map(([k, v]) => [k, v]));
    expect(event.tags.find((t) => t[0] === 'd')?.[1]).toBe('https://example.com/x');
    expect(map.title).toBe('Example');
    expect(map.description).toBe('desc');
    expect(map.published_at).toBe('1700000000');
    expect(map.published_at_ms).toBe('1700000000123');
    expect(map.lightning).toBe('me@getalby.com');
    expect(map.blossom).toBe('sha256-xyz');
    expect(map.wayback).toBe('https://web.archive.org/...');
    expect(map['archive-tier']).toBe('forever');
    const tagValues = event.tags.filter((t) => t[0] === 't').map((t) => t[1]);
    expect(tagValues).toEqual(['bitcoin', 'lightning']);
  });

  it('omits optional tags when absent', () => {
    const event = buildBookmarkEvent({ url: 'https://x', tags: [] });
    const keys = event.tags.map((t) => t[0]);
    expect(keys).not.toContain('blossom');
    expect(keys).not.toContain('wayback');
    expect(keys).not.toContain('archive-tier');
    expect(keys).not.toContain('published_at');
    expect(keys).not.toContain('lightning');
  });
});

describe('parseBookmarkEvent', () => {
  it('round-trips through buildBookmarkEvent', () => {
    const template = buildBookmarkEvent({
      url: 'https://example.com/y',
      title: 'Y',
      description: 'desc',
      tags: ['a', 'b'],
      archivedForever: true
    });
    const parsed = parseBookmarkEvent({
      ...template,
      id: 'evt-1',
      pubkey: 'pub-1'
    });
    expect(parsed).toMatchObject({
      url: 'https://example.com/y',
      title: 'Y',
      description: 'desc',
      tags: ['a', 'b'],
      archivedForever: true,
      curator: 'pub-1',
      eventId: 'evt-1'
    });
  });

  it('uses published_at as the bookmark save time when present', () => {
    const parsed = parseBookmarkEvent({
      id: 'evt-1',
      pubkey: 'pub-1',
      kind: KIND.webBookmark,
      created_at: 1_800_000_000,
      tags: [
        ['d', 'https://example.com/yesterday'],
        ['published_at', '1700000000'],
      ],
      content: '',
    });

    expect(parsed?.publishedAt).toBe(1_700_000_000);
    expect(parsed?.savedAt).toBe(1_700_000_000);
  });

  it('uses published_at_ms as the bookmark millisecond sort time when it matches published_at', () => {
    const parsed = parseBookmarkEvent({
      id: 'evt-1',
      pubkey: 'pub-1',
      kind: KIND.webBookmark,
      created_at: 1_800_000_000,
      tags: [
        ['d', 'https://example.com/ms'],
        ['published_at', '1700000000'],
        ['published_at_ms', '1700000000123'],
      ],
      content: '',
    });

    expect(parsed?.savedAt).toBe(1_700_000_000);
    expect(parsed?.savedAtMs).toBe(1_700_000_000_123);
  });

  it('falls back to event created_at when published_at is invalid', () => {
    const parsed = parseBookmarkEvent({
      id: 'evt-1',
      pubkey: 'pub-1',
      kind: KIND.webBookmark,
      created_at: 1_800_000_000,
      tags: [
        ['d', 'https://example.com/fallback'],
        ['published_at', 'not-a-time'],
      ],
      content: '',
    });

    expect(parsed?.publishedAt).toBeUndefined();
    expect(parsed?.savedAt).toBe(1_800_000_000);
  });

  it('returns null for non-bookmark kinds', () => {
    expect(
      parseBookmarkEvent({
        id: 'x',
        pubkey: 'p',
        kind: 1,
        created_at: 0,
        tags: [['d', 'https://x']],
        content: ''
      })
    ).toBeNull();
  });

  it('returns null when the d-tag URL is missing', () => {
    expect(
      parseBookmarkEvent({
        id: 'x',
        pubkey: 'p',
        kind: KIND.webBookmark,
        created_at: 0,
        tags: [['title', 'no url here']],
        content: ''
      })
    ).toBeNull();
  });
});

describe('compareBookmarksNewest', () => {
  function bookmark(url: string, savedAt: number, savedAtMs?: number): ParsedBookmark {
    return {
      url,
      title: url,
      description: '',
      tags: [],
      archivedForever: false,
      savedAt,
      savedAtMs,
      curator: 'pub',
      eventId: url
    };
  }

  it('uses millisecond save time to order same-second saves', () => {
    const older = bookmark('https://old.example', 100, 100_100);
    const newer = bookmark('https://new.example', 100, 100_900);
    expect([older, newer].sort(compareBookmarksNewest).map((b) => b.url)).toEqual([
      'https://new.example',
      'https://old.example'
    ]);
  });

  it('falls back to savedAt for relay/API rows without millisecond time', () => {
    const older = bookmark('https://old.example', 100);
    const newer = bookmark('https://new.example', 101);
    expect([older, newer].sort(compareBookmarksNewest).map((b) => b.url)).toEqual([
      'https://new.example',
      'https://old.example'
    ]);
  });
});
