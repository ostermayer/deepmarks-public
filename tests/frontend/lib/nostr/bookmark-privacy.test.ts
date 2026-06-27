import { describe, expect, it } from 'vitest';
import { isPrivateBookmark } from '$lib/nostr/bookmark-privacy.js';
import type { ParsedBookmark } from '$lib/nostr/bookmarks.js';

function bookmark(overrides: Partial<ParsedBookmark> & { eventId: string }): ParsedBookmark {
  return {
    url: 'https://example.com',
    title: 'Example',
    description: '',
    tags: [],
    savedAt: 1_700_000_000,
    curator: 'a'.repeat(64),
    archivedForever: false,
    ...overrides,
  };
}

describe('isPrivateBookmark', () => {
  it('recognizes Deepmarks-native private rows', () => {
    expect(isPrivateBookmark(bookmark({ eventId: 'private:https://example.com' }))).toBe(true);
  });

  it('recognizes imported private NIP-51 rows without a private event id', () => {
    const imported = {
      ...bookmark({ eventId: `nip51-note:${'b'.repeat(64)}:${'c'.repeat(64)}` }),
      visibility: 'private',
    } as ParsedBookmark;

    expect(isPrivateBookmark(imported)).toBe(true);
  });

  it('treats untagged and public-visibility rows as public', () => {
    expect(isPrivateBookmark(bookmark({ eventId: 'public-event' }))).toBe(false);
    expect(isPrivateBookmark({
      ...bookmark({ eventId: 'list-event' }),
      visibility: 'public',
    } as ParsedBookmark)).toBe(false);
  });
});

