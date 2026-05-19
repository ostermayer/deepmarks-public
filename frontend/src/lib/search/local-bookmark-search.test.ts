import { describe, expect, it } from 'vitest';
import type { ParsedBookmark } from '$lib/nostr/bookmarks';
import { searchLocalBookmarks } from './local-bookmark-search';

function bookmark(overrides: Partial<ParsedBookmark>): ParsedBookmark {
  return {
    url: 'https://example.com',
    title: 'Example',
    description: '',
    tags: [],
    archivedForever: false,
    savedAt: 1,
    curator: 'pub',
    eventId: 'event',
    ...overrides,
  };
}

describe('searchLocalBookmarks', () => {
  it('matches words in bookmark titles by default', () => {
    const bookmarks = [
      bookmark({ title: 'Nostr relay guide', url: 'https://a.test', eventId: 'a' }),
      bookmark({ title: 'Lightning wallets', url: 'https://b.test', eventId: 'b' }),
    ];

    expect(searchLocalBookmarks(bookmarks, 'relay').map((b) => b.eventId)).toEqual(['a']);
  });

  it('matches words in bookmark descriptions', () => {
    const bookmarks = [
      bookmark({ title: 'Crawler project', description: 'Open-source LLM friendly scraper', eventId: 'description-hit' }),
      bookmark({ title: 'Crawler project', description: 'No matching text here', eventId: 'miss' }),
    ];

    expect(searchLocalBookmarks(bookmarks, 'scraper').map((b) => b.eventId)).toEqual(['description-hit']);
  });

  it('matches private bookmarks the same way as public bookmarks', () => {
    const bookmarks = [
      bookmark({ title: 'Private Orion note', eventId: 'private:https://orion.test' }),
    ];

    expect(searchLocalBookmarks(bookmarks, 'orion')).toHaveLength(1);
  });

  it('matches tag and site modifiers locally', () => {
    const bookmarks = [
      bookmark({ title: 'One', url: 'https://stacker.news/items/1', tags: ['bitcoin'] }),
      bookmark({ title: 'Two', url: 'https://example.com/items/2', tags: ['bitcoin'] }),
      bookmark({ title: 'Three', url: 'https://stacker.news/items/3', tags: ['nostr'] }),
    ];

    expect(searchLocalBookmarks(bookmarks, '#bitcoin site:stacker.news').map((b) => b.title)).toEqual(['One']);
  });

  it('keeps leading-dot private tags distinct from public tags', () => {
    const bookmarks = [
      bookmark({ title: 'Private', tags: ['.client'], eventId: 'private-tag' }),
      bookmark({ title: 'Public', tags: ['client'], eventId: 'public-tag' }),
    ];

    expect(searchLocalBookmarks(bookmarks, '#.client').map((b) => b.title)).toEqual(['Private']);
    expect(searchLocalBookmarks(bookmarks, '#client').map((b) => b.title)).toEqual(['Public']);
  });

  it('matches after and before date modifiers locally', () => {
    const bookmarks = [
      bookmark({ title: 'Old', savedAt: Date.parse('2023-12-31T00:00:00Z') / 1000, eventId: 'old' }),
      bookmark({ title: 'Inside', savedAt: Date.parse('2024-06-10T00:00:00Z') / 1000, eventId: 'inside' }),
      bookmark({ title: 'New', savedAt: Date.parse('2025-01-01T00:00:00Z') / 1000, eventId: 'new' }),
    ];

    expect(
      searchLocalBookmarks(bookmarks, 'after:2024-01-01 before:2024-12-31').map((b) => b.title),
    ).toEqual(['Inside']);
  });

  it('requires every plain term to match somewhere on the bookmark', () => {
    const bookmarks = [
      bookmark({ title: 'Nostr relay guide', description: 'for beginners' }),
      bookmark({ title: 'Nostr client guide', description: 'relay setup missing' }),
    ];

    expect(searchLocalBookmarks(bookmarks, 'nostr relay').map((b) => b.title)).toEqual([
      'Nostr relay guide',
      'Nostr client guide',
    ]);
  });
});
