import { describe, it, expect } from 'vitest';
import { relativeTime } from './time.js';

const NOW_S = 1_700_000_000;
const now = () => NOW_S * 1000;

describe('relativeTime', () => {
  it('returns "never" for the zero sentinel', () => {
    expect(relativeTime(0, now)).toBe('never');
  });
  it('returns "just now" within the same minute', () => {
    expect(relativeTime(NOW_S - 30, now)).toBe('just now');
    expect(relativeTime(NOW_S, now)).toBe('just now');
  });
  it('bucketizes minutes inside the current hour', () => {
    expect(relativeTime(NOW_S - 60, now)).toBe('1 min ago');
    expect(relativeTime(NOW_S - 60 * 45, now)).toBe('45 min ago');
  });
  it('bucketizes hours within the same day', () => {
    expect(relativeTime(NOW_S - 3600, now)).toBe('1 hours ago');
    expect(relativeTime(NOW_S - 3600 * 5, now)).toBe('5 hours ago');
  });
  it('returns "yesterday" for 1–2 days back', () => {
    expect(relativeTime(NOW_S - 86400, now)).toBe('yesterday');
    expect(relativeTime(NOW_S - 86400 - 3600, now)).toBe('yesterday');
  });
  it('returns "N days ago" up to a fortnight', () => {
    expect(relativeTime(NOW_S - 86400 * 5, now)).toBe('5 days ago');
    expect(relativeTime(NOW_S - 86400 * 13, now)).toBe('13 days ago');
  });
  it('falls back to locale date past the fortnight', () => {
    const two_months_ago = NOW_S - 86400 * 60;
    const out = relativeTime(two_months_ago, now);
    expect(out).not.toMatch(/days ago/);
    expect(out.length).toBeGreaterThan(0);
  });
  it('guards against clock skew (future timestamp) by returning "just now"', () => {
    expect(relativeTime(NOW_S + 60, now)).toBe('just now');
  });
});
