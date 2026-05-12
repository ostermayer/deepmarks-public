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
