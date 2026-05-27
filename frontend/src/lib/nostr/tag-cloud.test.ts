import { describe, it, expect } from 'vitest';
import { bucketize, countTags, countTagsWithZapSats, tagCloudFrom } from './tag-cloud.js';
import type { ParsedBookmark } from './bookmarks.js';

function bm(tags: string[]): ParsedBookmark {
  return {
    url: `https://x.test/${tags.join('-') || 'none'}`,
    title: 't',
    description: '',
    tags,
    archivedForever: false,
    savedAt: 0,
    curator: 'pub',
    eventId: `${Math.random()}`,
  };
}

describe('countTags', () => {
  it('aggregates across bookmarks, lowercased', () => {
    const out = countTags([
      bm(['Bitcoin', 'lightning']),
      bm(['BITCOIN', 'nostr']),
      bm(['bitcoin']),
    ]);
    expect(out).toEqual([
      { name: 'bitcoin', count: 3 },
      { name: 'lightning', count: 1 },
      { name: 'nostr', count: 1 },
    ]);
  });

  it('sorts by count desc then name asc', () => {
    const out = countTags([bm(['bb', 'aa', 'cc'])]);
    expect(out.map((t) => t.name)).toEqual(['aa', 'bb', 'cc']);
  });

  it('ignores empty / whitespace-only tags', () => {
    const out = countTags([bm(['', '   ', 'real'])]);
    expect(out).toEqual([{ name: 'real', count: 1 }]);
  });

  it('returns [] on empty input', () => {
    expect(countTags([])).toEqual([]);
  });
});

describe('countTagsWithZapSats', () => {
  it('aggregates zap sats across every bookmark with a tag', () => {
    const first = bm(['nostr', 'video']);
    const second = bm(['nostr']);
    first.eventId = 'a'.repeat(64);
    second.eventId = 'b'.repeat(64);

    expect(countTagsWithZapSats([first, second], new Map([
      ['a'.repeat(64), { count: 1, totalMsat: 2_000 }],
      ['b'.repeat(64), { count: 1, totalMsat: 5_000 }],
    ]))).toEqual([
      { name: 'nostr', count: 2, zapSats: 7 },
      { name: 'video', count: 1, zapSats: 2 },
    ]);
  });
});

describe('bucketize', () => {
  it('singleton maps to weight 3 (mid-size)', () => {
    expect(bucketize([{ name: 'solo', count: 5 }])).toEqual([{ name: 'solo', weight: 3 }]);
  });
  it('[] → []', () => {
    expect(bucketize([])).toEqual([]);
  });
  it('assigns weight 5 to the most popular, weight 1 to the least', () => {
    const counts = Array.from({ length: 10 }, (_, i) => ({
      name: `t${i}`,
      count: 10 - i,
    }));
    const out = bucketize(counts);
    expect(out[0]?.weight).toBe(5);
    expect(out.at(-1)?.weight).toBe(1);
  });
  it('assigns equal weights to equal counts', () => {
    expect(bucketize([
      { name: 'ai', count: 1 },
      { name: 'nostr', count: 1 },
      { name: 'tools', count: 1 },
    ])).toEqual([
      { name: 'ai', weight: 3 },
      { name: 'nostr', weight: 3 },
      { name: 'tools', weight: 3 },
    ]);
  });
  it('keeps tied counts at the same size even with larger tags present', () => {
    const out = bucketize([
      { name: 'big', count: 5 },
      { name: 'small-a', count: 1 },
      { name: 'small-b', count: 1 },
    ]);
    expect(out[1]?.weight).toBe(out[2]?.weight);
  });
  it('produces only weights in the {1,2,3,4,5} set', () => {
    const counts = Array.from({ length: 30 }, (_, i) => ({ name: `t${i}`, count: 30 - i }));
    for (const { weight } of bucketize(counts)) {
      expect([1, 2, 3, 4, 5]).toContain(weight);
    }
  });
});

describe('tagCloudFrom', () => {
  it('keeps one bookmark with multiple tags at equal cloud sizes', () => {
    expect(tagCloudFrom([bm(['ai', 'nostr', 'tech'])])).toEqual([
      { name: 'ai', weight: 3 },
      { name: 'nostr', weight: 3 },
      { name: 'tech', weight: 3 },
    ]);
  });
  it('caps to `limit` items', () => {
    const bookmarks = Array.from({ length: 50 }, (_, i) => bm([`tag${i}`]));
    expect(tagCloudFrom(bookmarks, 10)).toHaveLength(10);
  });
  it('handles empty input', () => {
    expect(tagCloudFrom([])).toEqual([]);
  });
});
