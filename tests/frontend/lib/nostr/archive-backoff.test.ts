import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  archiveBackoffWindowMs,
  clearArchiveBackoff,
  isArchiveBackoffActive,
  recordArchiveFailureBackoff,
} from '$lib/nostr/archive-backoff';

class MapBackedStorage {
  private readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
}

const PK = 'a'.repeat(64);
const OTHER_PK = 'b'.repeat(64);
const URL = 'https://example.com/dead-page';
const HOUR_MS = 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

beforeEach(() => {
  vi.stubGlobal('localStorage', new MapBackedStorage());
});

describe('archive backoff ledger', () => {
  it('escalates the window 6h → 30d cap, mirroring the server gate', () => {
    expect(archiveBackoffWindowMs(1)).toBe(6 * HOUR_MS);
    expect(archiveBackoffWindowMs(2)).toBe(12 * HOUR_MS);
    expect(archiveBackoffWindowMs(3)).toBe(24 * HOUR_MS);
    // The 2026-08-21 loop reached 92 strikes on one URL — deep counts
    // converge on the 30-day cap instead of overflowing.
    expect(archiveBackoffWindowMs(92)).toBe(30 * 24 * HOUR_MS);
    expect(archiveBackoffWindowMs(0)).toBe(6 * HOUR_MS);
  });

  it('activates after a failure, lapses after the window, and widens per strike', () => {
    expect(isArchiveBackoffActive(PK, URL, T0)).toBe(false);

    recordArchiveFailureBackoff(PK, URL, T0);
    expect(isArchiveBackoffActive(PK, URL, T0 + HOUR_MS)).toBe(true);
    expect(isArchiveBackoffActive(PK, URL, T0 + 7 * HOUR_MS)).toBe(false);

    // Second consecutive failure → 12h window from the new failure time.
    const t1 = T0 + 7 * HOUR_MS;
    recordArchiveFailureBackoff(PK, URL, t1);
    expect(isArchiveBackoffActive(PK, URL, t1 + 11 * HOUR_MS)).toBe(true);
    expect(isArchiveBackoffActive(PK, URL, t1 + 13 * HOUR_MS)).toBe(false);
  });

  it('tracks per pubkey and per URL independently', () => {
    recordArchiveFailureBackoff(PK, URL, T0);
    expect(isArchiveBackoffActive(OTHER_PK, URL, T0 + HOUR_MS)).toBe(false);
    expect(isArchiveBackoffActive(PK, 'https://example.com/other', T0 + HOUR_MS)).toBe(false);
  });

  it('clears entries when the URL finally archives', () => {
    recordArchiveFailureBackoff(PK, URL, T0);
    clearArchiveBackoff(PK, [URL, 'https://example.com/never-tracked']);
    expect(isArchiveBackoffActive(PK, URL, T0 + HOUR_MS)).toBe(false);
    // A cleared URL starts over at strike 1 (6h), not where it left off.
    recordArchiveFailureBackoff(PK, URL, T0);
    expect(isArchiveBackoffActive(PK, URL, T0 + 7 * HOUR_MS)).toBe(false);
  });

  it('drops malformed and inert stored entries on load', () => {
    localStorage.setItem(`deepmarks-archive-backoff:v1:${PK}`, JSON.stringify({
      [URL]: { failures: 2, lastFailureAt: T0 },
      'https://example.com/stale': { failures: 5, lastFailureAt: T0 - 31 * 24 * HOUR_MS },
      'https://example.com/junk': { failures: 'many' },
      'https://example.com/junk2': 42,
    }));
    expect(isArchiveBackoffActive(PK, URL, T0 + HOUR_MS)).toBe(true);
    expect(isArchiveBackoffActive(PK, 'https://example.com/stale', T0 + HOUR_MS)).toBe(false);
    expect(isArchiveBackoffActive(PK, 'https://example.com/junk', T0 + HOUR_MS)).toBe(false);
  });

  it('no-ops safely without localStorage', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => recordArchiveFailureBackoff(PK, URL, T0)).not.toThrow();
    expect(() => clearArchiveBackoff(PK, [URL])).not.toThrow();
    expect(isArchiveBackoffActive(PK, URL, T0)).toBe(false);
  });
});
