import { describe, expect, it } from 'vitest';
import {
  PUBLIC_COLLECTION_PREFIX,
  bookmarksForCollection,
  buildPublicCollectionEvent,
  collectionSlugFromInput,
  emptyCollection,
  isDeepmarksCollectionDTag,
  parsePublicCollectionEvent,
  publicCollectionDTag,
  upsertCollectionMember,
} from '$lib/bookmark-collections.js';
import type { ParsedBookmark, SignedEventLike } from '$lib/nostr/bookmarks.js';

function event(tags: string[][], createdAt = 10): SignedEventLike {
  return {
    id: `event-${createdAt}`,
    kind: 30003,
    pubkey: 'a'.repeat(64),
    created_at: createdAt,
    tags,
    content: '',
  };
}

function bookmark(url: string, eventId = url): ParsedBookmark {
  return {
    url,
    title: url,
    description: '',
    tags: ['machine-learning'],
    archivedForever: false,
    savedAt: 1,
    curator: 'a'.repeat(64),
    eventId,
  };
}

describe('collectionSlugFromInput', () => {
  it('turns display names into stable URL slugs without reading bookmark tags', () => {
    expect(collectionSlugFromInput('#Machine Learning')).toBe('machine-learning');
    expect(collectionSlugFromInput('AI/research')).toBe('ai-research');
    expect(collectionSlugFromInput('  web.dev  ')).toBe('web-dev');
    expect(collectionSlugFromInput('###')).toBe('');
  });
});

describe('public collection events', () => {
  it('parses Deepmarks public collection members from r-tags', () => {
    const parsed = parsePublicCollectionEvent(event([
      ['d', `${PUBLIC_COLLECTION_PREFIX}reading-list`],
      ['title', 'Reading List'],
      ['r', 'https://example.test/a', 'A', '100'],
      ['r', 'https://example.test/b'],
      ['t', 'not-membership'],
    ]));

    expect(parsed).toMatchObject({
      slug: 'reading-list',
      title: 'Reading List',
      visibility: 'public',
      count: 2,
      publicCount: 2,
      privateCount: 0,
      urls: ['https://example.test/a', 'https://example.test/b'],
    });
  });

  it('ignores regular NIP-51 bookmark sets', () => {
    expect(parsePublicCollectionEvent(event([
      ['d', 'research'],
      ['r', 'https://example.test/a'],
    ]))).toBeNull();
  });

  it('builds an addressable public collection event', () => {
    const collection = upsertCollectionMember(
      emptyCollection('Reading List', 'a'.repeat(64), 'public'),
      { url: 'https://example.test/a', title: 'A', addedAt: 100 },
    );
    const built = buildPublicCollectionEvent(collection);

    expect(built.kind).toBe(30003);
    expect(built.content).toBe('');
    expect(built.tags).toContainEqual(['d', publicCollectionDTag('reading-list')]);
    expect(built.tags).toContainEqual(['title', 'Reading List']);
    expect(built.tags).toContainEqual(['r', 'https://example.test/a', 'A', '100']);
  });
});

describe('bookmarksForCollection', () => {
  it('filters bookmarks by explicit URL membership instead of tag names', () => {
    const included = bookmark('https://example.test/included', 'included');
    const sameTagButNotMember = bookmark('https://example.test/tag-only', 'tag-only');
    const collection = upsertCollectionMember(
      emptyCollection('Machine Learning', 'a'.repeat(64), 'public'),
      { url: included.url, title: 'Included' },
    );

    expect(bookmarksForCollection([included, sameTagButNotMember], collection)).toEqual([included]);
  });
});

describe('isDeepmarksCollectionDTag', () => {
  it('recognizes Deepmarks collection d-tags only', () => {
    expect(isDeepmarksCollectionDTag('deepmarks-collection:reading')).toBe(true);
    expect(isDeepmarksCollectionDTag('deepmarks-collection-private:abc')).toBe(true);
    expect(isDeepmarksCollectionDTag('reading')).toBe(false);
  });
});
