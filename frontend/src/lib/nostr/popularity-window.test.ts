import { describe, it, expect } from 'vitest';
import {
  customWindow,
  filterBookmarksByWindow,
  resolveWindow,
  WINDOW_LABELS,
} from './popularity-window.js';
import { tallyReceiptsInWindow } from './popularity.js';
import type { ParsedBookmark } from './bookmarks.js';

function bm(url: string, savedAt: number): ParsedBookmark {
  return {
    url,
    title: url,
    description: '',
    tags: [],
    archivedForever: false,
    savedAt,
    curator: 'c',
    eventId: `${url}:${savedAt}`,
  };
}

// Stable reference now for all resolveWindow assertions.
const NOW = new Date('2026-04-24T00:00:00Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const DAY = 86_400;

describe('resolveWindow', () => {
  it('all → [0, Infinity]', () => {
    const r = resolveWindow('all', NOW);
    expect(r.sinceSec).toBe(0);
    expect(r.untilSec).toBe(Number.POSITIVE_INFINITY);
  });

  it('24h → [now - 86400, Infinity]', () => {
    const r = resolveWindow('24h', NOW);
    expect(r.sinceSec).toBe(NOW_SEC - DAY);
    expect(r.untilSec).toBe(Number.POSITIVE_INFINITY);
  });

  it('week / month / year offsets match their day counts', () => {
    expect(resolveWindow('week', NOW).sinceSec).toBe(NOW_SEC - DAY * 7);
    expect(resolveWindow('month', NOW).sinceSec).toBe(NOW_SEC - DAY * 30);
    expect(resolveWindow('year', NOW).sinceSec).toBe(NOW_SEC - DAY * 365);
  });

  it('labels list is stable and excludes custom (the UI handles it separately)', () => {
    const kinds = WINDOW_LABELS.map((w) => w.kind);
    expect(kinds).toEqual(['all', 'year', 'month', 'week', '24h']);
  });
});

describe('customWindow', () => {
  it('converts Date bounds to unix seconds', () => {
    const since = new Date('2026-01-01T00:00:00Z');
    const until = new Date('2026-02-01T00:00:00Z');
    const r = customWindow(since, until);
    expect(r.kind).toBe('custom');
    expect(r.sinceSec).toBe(Math.floor(since.getTime() / 1000));
    expect(r.untilSec).toBe(Math.floor(until.getTime() / 1000));
  });

  it('null bounds default to 0 / Infinity respectively', () => {
    const r1 = customWindow(null, null);
    expect(r1.sinceSec).toBe(0);
    expect(r1.untilSec).toBe(Number.POSITIVE_INFINITY);

    const r2 = customWindow(new Date('2026-01-01Z'), null);
    expect(r2.untilSec).toBe(Number.POSITIVE_INFINITY);

    const r3 = customWindow(null, new Date('2026-12-31Z'));
    expect(r3.sinceSec).toBe(0);
  });
});

describe('filterBookmarksByWindow', () => {
  it('returns the same list unchanged for the all-time window (perf: no filter work)', () => {
    const input = [bm('https://a', 1), bm('https://b', 2)];
    const out = filterBookmarksByWindow(input, resolveWindow('all', NOW));
    expect(out).toBe(input);
  });

  it('excludes bookmarks outside the window', () => {
    const input = [
      bm('https://old',    NOW_SEC - DAY * 10),  // 10 days ago
      bm('https://recent', NOW_SEC - DAY * 3),   // 3 days ago
      bm('https://today',  NOW_SEC - 60),        // 1 minute ago
    ];
    const out = filterBookmarksByWindow(input, resolveWindow('week', NOW));
    const urls = out.map((b) => b.url).sort();
    expect(urls).toEqual(['https://recent', 'https://today']);
  });

  it('respects inclusive bounds — savedAt exactly at since is kept', () => {
    const range = resolveWindow('24h', NOW);
    const input = [bm('https://edge', range.sinceSec)];
    const out = filterBookmarksByWindow(input, range);
    expect(out).toHaveLength(1);
  });

  it('custom window constrains on both sides', () => {
    const range = customWindow(
      new Date('2026-01-10T00:00:00Z'),
      new Date('2026-01-20T00:00:00Z'),
    );
    const input = [
      bm('https://early', Math.floor(new Date('2026-01-05T00:00:00Z').getTime() / 1000)),
      bm('https://mid',   Math.floor(new Date('2026-01-15T00:00:00Z').getTime() / 1000)),
      bm('https://late',  Math.floor(new Date('2026-01-25T00:00:00Z').getTime() / 1000)),
    ];
    const out = filterBookmarksByWindow(input, range);
    expect(out.map((b) => b.url)).toEqual(['https://mid']);
  });
});

describe('tallyReceiptsInWindow', () => {
  const receipts = [
    { id: 'r1', eventId: 'evA', ts: NOW_SEC - DAY * 10, amountMsat: 1_000 }, // old
    { id: 'r2', eventId: 'evA', ts: NOW_SEC - DAY * 3,  amountMsat: 2_000 }, // within week
    { id: 'r3', eventId: 'evB', ts: NOW_SEC - 60,       amountMsat: 5_000 }, // today
    { id: 'r4', eventId: null,  ts: NOW_SEC - 60,       amountMsat: 99_000 }, // profile zap → skipped
    { id: 'r3', eventId: 'evB', ts: NOW_SEC - 60,       amountMsat: 5_000 }, // dup of r3 → skipped
  ];

  it('excludes receipts older than sinceSec', () => {
    const range = resolveWindow('week', NOW);
    const out = tallyReceiptsInWindow(receipts, range.sinceSec, range.untilSec);
    expect(out.get('evA')?.count).toBe(1);      // r1 dropped, r2 counted
    expect(out.get('evA')?.totalMsat).toBe(2_000);
    expect(out.get('evB')?.count).toBe(1);      // r3 counted once
  });

  it('excludes receipts without an eventId (profile zaps)', () => {
    const out = tallyReceiptsInWindow(receipts, 0);
    expect([...out.keys()].sort()).toEqual(['evA', 'evB']);
  });

  it('dedupes receipts by receipt id regardless of window', () => {
    const out = tallyReceiptsInWindow(receipts, 0);
    expect(out.get('evB')?.count).toBe(1);         // r3 appears twice in input
    expect(out.get('evB')?.totalMsat).toBe(5_000); // only counted once
  });

  it('all-time window counts every receipt with a valid eventId, summing msats', () => {
    const out = tallyReceiptsInWindow(receipts, 0);
    expect(out.get('evA')).toEqual({ count: 2, totalMsat: 3_000 });
    expect(out.get('evB')).toEqual({ count: 1, totalMsat: 5_000 });
  });

  it('custom upper bound excludes receipts after untilSec', () => {
    const untilSec = NOW_SEC - DAY * 5;
    const out = tallyReceiptsInWindow(receipts, 0, untilSec);
    expect(out.get('evA')?.count).toBe(1); // only r1 is <= untilSec
    expect(out.has('evB')).toBe(false);
  });
});
