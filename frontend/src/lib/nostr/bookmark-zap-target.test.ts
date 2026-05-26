import { describe, expect, it } from 'vitest';
import { bookmarkZapSats, bookmarkZapTargetEventId } from './bookmark-zap-target.js';
import type { ParsedBookmark } from './bookmarks.js';

function bookmark(overrides: Partial<ParsedBookmark> & { eventId: string }): ParsedBookmark {
  return {
    url: 'https://example.com',
    title: 'example',
    description: '',
    tags: [],
    archivedForever: false,
    savedAt: 1,
    curator: 'b'.repeat(64),
    ...overrides,
  };
}

describe('bookmark zap target', () => {
  it('uses the original kind:1 event for friends social-link rows', () => {
    const social = {
      ...bookmark({ eventId: `note-link:${'a'.repeat(64)}:0` }),
      source: 'nostr-note-link',
      sourceEventId: 'c'.repeat(64),
    };

    expect(bookmarkZapTargetEventId(social)).toBe('c'.repeat(64));
    expect(bookmarkZapSats(social, new Map([
      ['c'.repeat(64), { count: 2, totalMsat: 12_000 }],
    ]))).toBe(12);
  });

  it('uses normal bookmark event ids for kind:39701 rows', () => {
    const normal = bookmark({ eventId: 'd'.repeat(64) });
    expect(bookmarkZapTargetEventId(normal)).toBe('d'.repeat(64));
  });

  it('does not target synthetic row ids', () => {
    const synthetic = bookmark({ eventId: `note-link:${'a'.repeat(64)}:0` });
    expect(bookmarkZapTargetEventId(synthetic)).toBeNull();
  });
});
