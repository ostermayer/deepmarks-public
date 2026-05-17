import { describe, it, expect } from 'vitest';
import { buildBookmarkEvent, parseBookmarkEvent } from './bookmarks.js';
import { KIND } from './kinds.js';

describe('buildBookmarkEvent', () => {
  it('emits the CLAUDE.md tag schema for a public bookmark', () => {
    const event = buildBookmarkEvent({
      url: 'https://example.com/x',
      title: 'Example',
      description: 'desc',
      tags: ['bitcoin', 'lightning'],
      publishedAt: 1700000000,
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
