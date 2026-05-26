import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('normalizes natural date phrases into local date filters', () => {
    const bookmarks = [
      bookmark({ title: 'Old', savedAt: Date.parse('2023-12-31T00:00:00Z') / 1000, eventId: 'old' }),
      bookmark({ title: 'Two years ago A', savedAt: Date.parse('2024-02-10T00:00:00Z') / 1000, eventId: 'a' }),
      bookmark({ title: 'Two years ago B', savedAt: Date.parse('2024-11-20T00:00:00Z') / 1000, eventId: 'b' }),
      bookmark({ title: 'New', savedAt: Date.parse('2025-01-02T00:00:00Z') / 1000, eventId: 'new' }),
    ];

    expect(searchLocalBookmarks(bookmarks, 'show me my bookmarks from two years ago').map((b) => b.eventId)).toEqual([
      'b',
      'a',
    ]);
  });

  it('keeps a standalone natural date phrase literal so titles can match it', () => {
    const bookmarks = [
      bookmark({ title: 'from two years ago', savedAt: Date.parse('2026-01-01T00:00:00Z') / 1000, eventId: 'literal' }),
      bookmark({ title: 'unrelated', savedAt: Date.parse('2024-01-01T00:00:00Z') / 1000, eventId: 'date-only' }),
    ];

    expect(searchLocalBookmarks(bookmarks, 'from two years ago').map((b) => b.eventId)).toEqual(['literal']);
  });

  it('keeps meaningful terms while normalizing natural dates', () => {
    const bookmarks = [
      bookmark({ title: 'Bitcoin custody', savedAt: Date.parse('2025-03-01T00:00:00Z') / 1000, eventId: 'hit' }),
      bookmark({ title: 'Bitcoin custody', savedAt: Date.parse('2024-03-01T00:00:00Z') / 1000, eventId: 'wrong-year' }),
      bookmark({ title: 'Nostr custody', savedAt: Date.parse('2025-03-01T00:00:00Z') / 1000, eventId: 'wrong-term' }),
    ];

    expect(searchLocalBookmarks(bookmarks, 'bitcoin from last year').map((b) => b.eventId)).toEqual(['hit']);
  });

  it('normalizes pdf and scholarly language into filters', () => {
    const bookmarks = [
      bookmark({
        title: 'Creatine supplementation and mitochondrial dysfunction review',
        url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC8838971/',
        tags: ['medicine'],
        eventId: 'hit',
      }),
      bookmark({
        title: 'Creatine supplementation and mitochondrial dysfunction review',
        url: 'https://example.com/creatine-review',
        tags: ['medicine'],
        eventId: 'not-pdf-capable',
      }),
      bookmark({
        title: 'Creatine workout poster',
        url: 'https://example.com/creatine-poster.pdf',
        eventId: 'not-scholarly',
      }),
      bookmark({
        title: 'Mitochondrial dysfunction review',
        url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1/pdf/report.pdf',
        tags: ['medicine'],
        eventId: 'no-creatine',
      }),
    ];

    expect(searchLocalBookmarks(bookmarks, 'creatine papers with pdfs').map((b) => b.eventId)).toEqual(['hit']);
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
