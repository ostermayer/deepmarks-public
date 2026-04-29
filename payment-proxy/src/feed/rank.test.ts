import { describe, it, expect } from 'vitest';
import { rankByPopularity } from './rank.js';
import type { BookmarkJson } from '../api-helpers.js';

function bm(pubkey: string, url: string, savedAt = 0, id = `${pubkey}-${url}`): BookmarkJson {
  return {
    id,
    pubkey,
    url,
    title: url,
    description: '',
    tags: [],
    archivedForever: false,
    savedAt,
  };
}

describe('rankByPopularity (backend)', () => {
  it('counts distinct curators per URL', () => {
    const out = rankByPopularity([
      bm('alice', 'https://x'),
      bm('bob', 'https://x'),
      bm('carol', 'https://x'),
      bm('alice', 'https://y'),
    ]);
    expect(out.find((b) => b.url === 'https://x')?.saveCount).toBe(3);
    expect(out.find((b) => b.url === 'https://y')?.saveCount).toBe(1);
  });

  it('dedupes same-curator re-saves', () => {
    const out = rankByPopularity([bm('a', 'https://x', 1), bm('a', 'https://x', 2)]);
    expect(out[0]?.saveCount).toBe(1);
  });

  it('keeps the freshest representative (max savedAt, tie → lex id)', () => {
    const out = rankByPopularity([
      bm('a', 'https://x', 100, 'aaa'),
      bm('b', 'https://x', 100, 'bbb'),
    ]);
    expect(out[0]?.id).toBe('bbb');
  });

  it('sorts by saveCount desc, recency tie-break', () => {
    const out = rankByPopularity([
      bm('a', 'https://hot', 0),
      bm('b', 'https://hot', 0),
      bm('a', 'https://newer', 999),
      bm('a', 'https://older', 50),
    ]);
    expect(out.map((b) => b.url)).toEqual(['https://hot', 'https://newer', 'https://older']);
  });

  it('returns empty for empty input', () => {
    expect(rankByPopularity([])).toEqual([]);
  });
});
