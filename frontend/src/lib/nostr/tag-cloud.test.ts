import { describe, it, expect } from 'vitest';
import { bucketize, countTags, tagCloudFrom } from './tag-cloud.js';
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
  it('produces only weights in the {1,2,3,4,5} set', () => {
    const counts = Array.from({ length: 30 }, (_, i) => ({ name: `t${i}`, count: 30 - i }));
    for (const { weight } of bucketize(counts)) {
      expect([1, 2, 3, 4, 5]).toContain(weight);
    }
  });
});

describe('tagCloudFrom', () => {
  it('caps to `limit` items', () => {
    const bookmarks = Array.from({ length: 50 }, (_, i) => bm([`tag${i}`]));
    expect(tagCloudFrom(bookmarks, 10)).toHaveLength(10);
  });
  it('handles empty input', () => {
    expect(tagCloudFrom([])).toEqual([]);
  });
});
