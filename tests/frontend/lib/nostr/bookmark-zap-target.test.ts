import { describe, expect, it } from 'vitest';
import {
  bookmarkZapSats,
  bookmarkZapTargetEventId,
  bookmarkZapTargetEventIds,
  sortBookmarksByZapSats,
} from '$lib/nostr/bookmark-zap-target.js';
import type { ParsedBookmark } from '$lib/nostr/bookmarks.js';

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

  it('uses the target note for kind:39701 rows that bookmark Nostr content', () => {
    const target = 'e'.repeat(64);
    const normal = bookmark({
      eventId: 'd'.repeat(64),
      url: `https://primal.net/e/${target}`,
    });
    expect(bookmarkZapTargetEventId(normal)).toBe(target);
  });

  it('does not target synthetic row ids', () => {
    const synthetic = bookmark({ eventId: `note-link:${'a'.repeat(64)}:0` });
    expect(bookmarkZapTargetEventId(synthetic)).toBeNull();
  });

  it('collects unique zap target ids for bounded receipt queries', () => {
    const normal = bookmark({ eventId: 'd'.repeat(64) });
    const social = {
      ...bookmark({ eventId: `note-link:${'a'.repeat(64)}:0` }),
      source: 'nostr-note-link',
      sourceEventId: 'c'.repeat(64),
    };
    const duplicateSocial = {
      ...bookmark({ eventId: `note-link:${'b'.repeat(64)}:0` }),
      source: 'nostr-note-link',
      sourceEventId: 'c'.repeat(64),
    };

    expect(bookmarkZapTargetEventIds([normal, social, duplicateSocial])).toEqual([
      'd'.repeat(64),
      'c'.repeat(64),
    ]);
  });

  it('sorts by total zap sats and uses recency as the tiebreaker', () => {
    const low = bookmark({ eventId: '1'.repeat(64), url: 'https://example.com/low', savedAt: 20 });
    const high = bookmark({ eventId: '2'.repeat(64), url: 'https://example.com/high', savedAt: 10 });
    const tiedNewer = bookmark({ eventId: '3'.repeat(64), url: 'https://example.com/newer', savedAt: 30 });
    const tiedOlder = bookmark({ eventId: '4'.repeat(64), url: 'https://example.com/older', savedAt: 5 });

    const sorted = sortBookmarksByZapSats([low, tiedOlder, high, tiedNewer], new Map([
      ['1'.repeat(64), { count: 1, totalMsat: 1_000 }],
      ['2'.repeat(64), { count: 2, totalMsat: 20_000 }],
      ['3'.repeat(64), { count: 1, totalMsat: 5_000 }],
      ['4'.repeat(64), { count: 1, totalMsat: 5_000 }],
    ]));

    expect(sorted.map((item) => item.url)).toEqual([
      'https://example.com/high',
      'https://example.com/newer',
      'https://example.com/older',
      'https://example.com/low',
    ]);
  });
});
