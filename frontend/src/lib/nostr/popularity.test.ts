import { describe, it, expect } from 'vitest';
import {
  ZAP_WEIGHT,
  applyPopularityFloor,
  parseZapAmountMsat,
  rankByPopularity,
  tallyZapReceipts,
  type RankedBookmark,
} from './popularity.js';
import type { ParsedBookmark } from './bookmarks.js';

function bm(curator: string, url: string, savedAt = 0, eventId = `${curator}-${url}`): ParsedBookmark {
  return {
    url,
    title: url,
    description: '',
    tags: [],
    archivedForever: false,
    savedAt,
    curator,
    eventId
  };
}

describe('rankByPopularity — save counts (no zaps)', () => {
  it('counts distinct curators per URL', () => {
    const out = rankByPopularity([
      bm('alice', 'https://x'),
      bm('bob', 'https://x'),
      bm('carol', 'https://x'),
      bm('alice', 'https://y'),
    ]);
    const map = Object.fromEntries(out.map((b) => [b.url, b.saveCount]));
    expect(map['https://x']).toBe(3);
    expect(map['https://y']).toBe(1);
  });

  it('ignores re-saves by the same curator (no double-counting)', () => {
    const out = rankByPopularity([
      bm('alice', 'https://x', 100),
      bm('alice', 'https://x', 200),
    ]);
    expect(out[0]?.saveCount).toBe(1);
  });

  it('keeps the freshest representative per URL', () => {
    const out = rankByPopularity([
      bm('alice', 'https://x', 100, 'alice-old'),
      bm('bob', 'https://x', 200, 'bob-newer'),
    ]);
    expect(out[0]?.curator).toBe('bob');
    expect(out[0]?.savedAt).toBe(200);
  });

  it('breaks savedAt ties by lexicographic event id', () => {
    const out = rankByPopularity([
      bm('alice', 'https://x', 100, 'aaa'),
      bm('bob', 'https://x', 100, 'bbb'),
    ]);
    expect(out[0]?.eventId).toBe('bbb');
  });

  it('exposes zapCount=0 and score=saveCount when no zap data is provided', () => {
    const out = rankByPopularity([bm('alice', 'https://x'), bm('bob', 'https://x')]);
    expect(out[0]?.zapCount).toBe(0);
    expect(out[0]?.score).toBe(2);
  });

  it('returns an empty array for empty input', () => {
    expect(rankByPopularity([])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [bm('alice', 'https://x'), bm('bob', 'https://x')];
    const before = JSON.stringify(input);
    rankByPopularity(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('rankByPopularity — saves + zaps × 2', () => {
  it('weights a zap as twice a save in the score', () => {
    // URL A: 2 saves, 0 zaps  → score 2
    // URL B: 1 save,  1 zap   → score 1 + 1×2 = 3  (wins)
    const out = rankByPopularity(
      [
        bm('alice', 'https://a', 0, 'evA-alice'),
        bm('bob', 'https://a', 0, 'evA-bob'),
        bm('alice', 'https://b', 0, 'evB-alice'),
      ],
      new Map([['evB-alice', 1]]),
    );
    expect(out.map((b) => b.url)).toEqual(['https://b', 'https://a']);
    const byUrl = Object.fromEntries(out.map((b) => [b.url, b]));
    expect(byUrl['https://b']?.score).toBe(3);
    expect(byUrl['https://b']?.zapCount).toBe(1);
    expect(byUrl['https://a']?.score).toBe(2);
    expect(byUrl['https://a']?.zapCount).toBe(0);
  });

  it('aggregates zap counts across every event id that represents the URL', () => {
    // Two curators saved the same URL with different event ids; zaps
    // landed on both over time. Both receipts should count for the URL.
    const out = rankByPopularity(
      [
        bm('alice', 'https://x', 0, 'evX-alice'),
        bm('bob', 'https://x', 0, 'evX-bob'),
      ],
      new Map([
        ['evX-alice', 3],
        ['evX-bob', 2],
      ]),
    );
    expect(out[0]?.zapCount).toBe(5);
    expect(out[0]?.score).toBe(2 + 5 * ZAP_WEIGHT);
  });

  it('ignores zap counts for event ids that are not in the bookmark set', () => {
    const out = rankByPopularity(
      [bm('alice', 'https://x', 0, 'evX')],
      new Map([
        ['evX', 2],
        ['someone-else', 99],
      ]),
    );
    expect(out[0]?.zapCount).toBe(2);
  });

  it('sorts by score desc, then stable hash tiebreaker (not savedAt)', () => {
    // Equal scores; hash-based tiebreaker must not degrade to savedAt
    // (which would make "popular" look identical to "recent" on the
    // bootstrap path).
    const out = rankByPopularity(
      [
        bm('alice', 'https://hot', 100),
        bm('bob', 'https://hot', 100),
        bm('alice', 'https://newer', 999),
      ],
      new Map(),
    );
    // 'https://hot' has 2 saves → score 2; 'https://newer' has 1 save → score 1
    expect(out.map((b) => b.url)).toEqual(['https://hot', 'https://newer']);
  });

  it('exposes ZAP_WEIGHT as a module constant for UI transparency', () => {
    expect(ZAP_WEIGHT).toBe(2);
  });
});

describe('tallyZapReceipts', () => {
  it('counts one receipt per e-tag target', () => {
    const out = tallyZapReceipts([
      { id: 'r1', tags: [['e', 'evA']] },
      { id: 'r2', tags: [['e', 'evA']] },
      { id: 'r3', tags: [['e', 'evB']] },
    ]);
    expect(out.get('evA')).toBe(2);
    expect(out.get('evB')).toBe(1);
  });

  it('dedupes receipts by receipt event id (handles multi-relay delivery)', () => {
    const out = tallyZapReceipts([
      { id: 'r1', tags: [['e', 'evA']] },
      { id: 'r1', tags: [['e', 'evA']] }, // same receipt id again
    ]);
    expect(out.get('evA')).toBe(1);
  });

  it('ignores receipts without an e tag (profile zaps, etc.)', () => {
    const out = tallyZapReceipts([
      { id: 'r1', tags: [['p', 'pubkey']] },
      { id: 'r2', tags: [['e', 'evA']] },
    ]);
    expect(out.get('evA')).toBe(1);
    expect(out.size).toBe(1);
  });

  it('ignores receipts with an empty e-tag value', () => {
    const out = tallyZapReceipts([
      { id: 'r1', tags: [['e', '']] },
      { id: 'r2', tags: [['e', 'evA']] },
    ]);
    expect(out.get('evA')).toBe(1);
    expect(out.get('')).toBeUndefined();
  });

  it('returns an empty map for empty input', () => {
    expect(tallyZapReceipts([]).size).toBe(0);
  });
});

// ── parseZapAmountMsat ────────────────────────────────────────────────

describe('parseZapAmountMsat', () => {
  it('reads amount from the description (zap request JSON)', () => {
    const zapRequest = JSON.stringify({
      kind: 9734,
      tags: [
        ['p', 'x'.repeat(64)],
        ['amount', '21000'],
      ],
      content: '',
    });
    const out = parseZapAmountMsat([
      ['description', zapRequest],
      ['bolt11', 'lnbc1u1p…'],
    ]);
    expect(out).toBe(21_000);
  });

  it('falls back to the BOLT-11 prefix when description lacks an amount tag', () => {
    // lnbc21u = 21 micro-BTC = 21 × 10^5 msat = 2_100_000 msat
    const out = parseZapAmountMsat([['bolt11', 'lnbc21u1p3xnhl2pp5…']]);
    expect(out).toBe(2_100_000);
  });

  it('parses the milli-BTC unit correctly', () => {
    // lnbc1m = 1 mBTC = 1 × 10^8 msat = 100_000_000 msat
    const out = parseZapAmountMsat([['bolt11', 'lnbc1m1p…']]);
    expect(out).toBe(100_000_000);
  });

  it('parses the nano-BTC unit correctly', () => {
    // lnbc1000n = 1000 × 100 = 100_000 msat
    const out = parseZapAmountMsat([['bolt11', 'lnbc1000n1p…']]);
    expect(out).toBe(100_000);
  });

  it('returns 0 when neither tag yields a parseable amount', () => {
    expect(parseZapAmountMsat([['e', 'evA']])).toBe(0);
  });

  it('tolerates malformed description JSON', () => {
    const out = parseZapAmountMsat([
      ['description', 'not-json'],
      ['bolt11', 'lnbc21u1p…'],
    ]);
    expect(out).toBe(2_100_000);
  });
});

// ── applyPopularityFloor ──────────────────────────────────────────────

function ranked(
  overrides: Partial<RankedBookmark> & Pick<RankedBookmark, 'curator'>,
): RankedBookmark {
  return {
    url: 'https://x',
    title: '',
    description: '',
    tags: [],
    archivedForever: false,
    savedAt: 0,
    eventId: `${overrides.curator}-x`,
    saveCount: 1,
    zapCount: 0,
    totalZapSats: 0,
    score: 1,
    ...overrides,
  };
}

describe('applyPopularityFloor', () => {
  const BRAND = 'brand-pubkey';
  const OTHER = 'someone-else';

  it('gives brand-curated entries an unconditional editorial pass', () => {
    // Single-save Pinboard seed with no zaps → still shows.
    const out = applyPopularityFloor(
      [
        ranked({ curator: BRAND, score: 1, totalZapSats: 0 }),
        ranked({ curator: BRAND, score: 0, totalZapSats: 0 }),
      ],
      { brandPubkey: BRAND },
    );
    expect(out).toHaveLength(2);
  });

  it('applies the baseline score floor to firehose (non-brand) entries only', () => {
    const out = applyPopularityFloor(
      [
        ranked({ curator: OTHER, score: 1, totalZapSats: 10_000 }), // bad score
        ranked({ curator: OTHER, score: 2, totalZapSats: 10_000 }), // both floors ok
        ranked({ curator: BRAND, score: 1, totalZapSats: 0 }),      // brand pass
      ],
      { brandPubkey: BRAND },
    );
    expect(out).toHaveLength(2);
    expect(out.map((b) => b.curator).sort()).toEqual([BRAND, OTHER]);
  });

  it('requires firehose (non-brand) entries to exceed 500 sats zapped', () => {
    const out = applyPopularityFloor(
      [
        ranked({ curator: OTHER, score: 5, totalZapSats: 499 }),   // just below
        ranked({ curator: OTHER, score: 5, totalZapSats: 500 }),   // exactly at (strict >)
        ranked({ curator: OTHER, score: 5, totalZapSats: 501 }),   // just over — keep
        ranked({ curator: OTHER, score: 5, totalZapSats: 10_000 }),// clearly over — keep
      ],
      { brandPubkey: BRAND },
    );
    expect(out.map((b) => b.totalZapSats)).toEqual([501, 10_000]);
  });

  it('firehose entries must also meet the baseline score even when zapped heavily', () => {
    const out = applyPopularityFloor(
      [ranked({ curator: OTHER, score: 1, totalZapSats: 10_000 })],
      { brandPubkey: BRAND },
    );
    expect(out).toEqual([]);
  });

  it('treats every entry as firehose when brandPubkey is omitted', () => {
    const out = applyPopularityFloor(
      [
        ranked({ curator: BRAND, score: 5, totalZapSats: 0 }),   // dropped — no brand override
        ranked({ curator: OTHER, score: 5, totalZapSats: 1000 }),// kept
      ],
    );
    expect(out.map((b) => b.curator)).toEqual([OTHER]);
  });

  it('custom thresholds override the defaults', () => {
    const out = applyPopularityFloor(
      [
        ranked({ curator: OTHER, score: 1, totalZapSats: 100 }),
        ranked({ curator: OTHER, score: 1, totalZapSats: 50 }),
      ],
      { minScore: 1, firehoseMinZapSats: 75 },
    );
    expect(out.map((b) => b.totalZapSats)).toEqual([100]);
  });
});
