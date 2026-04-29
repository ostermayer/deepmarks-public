// Shared time-window definitions for popularity filtering.
// Pure + tiny; no Nostr or Svelte deps so tests and the UI pill row
// both consume it without dragging in network code.

import type { ParsedBookmark } from './bookmarks.js';

export type WindowKind = 'all' | '24h' | 'week' | 'month' | 'year' | 'custom';

export interface WindowRange {
  kind: WindowKind;
  /** Inclusive lower bound in unix seconds. */
  sinceSec: number;
  /** Inclusive upper bound in unix seconds (defaults to Infinity). */
  untilSec: number;
}

const DAY = 86_400;

/** Presets keyed by `kind`. `custom` is constructed by the UI with user
 *  input; `all` is 0 → Infinity which matches the full history. */
export function resolveWindow(
  kind: Exclude<WindowKind, 'custom'>,
  now: Date = new Date(),
): WindowRange {
  const nowSec = Math.floor(now.getTime() / 1000);
  const untilSec = Number.POSITIVE_INFINITY;
  switch (kind) {
    case 'all':   return { kind, sinceSec: 0,                 untilSec };
    case '24h':   return { kind, sinceSec: nowSec - DAY,      untilSec };
    case 'week':  return { kind, sinceSec: nowSec - DAY * 7,  untilSec };
    case 'month': return { kind, sinceSec: nowSec - DAY * 30, untilSec };
    case 'year':  return { kind, sinceSec: nowSec - DAY * 365, untilSec };
  }
}

/** Build a custom range from two Dates. Either bound can be null → Infinity
 *  / 0 on that side. If since > until, the result is an empty range
 *  (no bookmarks or receipts can satisfy it) — caller's lists go empty
 *  and the UI should validate rather than swallow. */
export function customWindow(since: Date | null, until: Date | null): WindowRange {
  return {
    kind: 'custom',
    sinceSec: since ? Math.floor(since.getTime() / 1000) : 0,
    untilSec: until ? Math.floor(until.getTime() / 1000) : Number.POSITIVE_INFINITY,
  };
}

/** Filter bookmarks by `savedAt` ∈ [sinceSec, untilSec]. Pure. */
export function filterBookmarksByWindow<B extends ParsedBookmark>(
  bookmarks: B[],
  range: WindowRange,
): B[] {
  if (range.sinceSec === 0 && range.untilSec === Number.POSITIVE_INFINITY) {
    return bookmarks;
  }
  return bookmarks.filter(
    (b) => b.savedAt >= range.sinceSec && b.savedAt <= range.untilSec,
  );
}

/** Labels for the UI pill row. Ordered for display. */
export const WINDOW_LABELS: Array<{ kind: Exclude<WindowKind, 'custom'>; label: string }> = [
  { kind: 'all',   label: 'all time' },
  { kind: 'year',  label: 'year' },
  { kind: 'month', label: 'month' },
  { kind: 'week',  label: 'week' },
  { kind: '24h',   label: '24h' },
];
