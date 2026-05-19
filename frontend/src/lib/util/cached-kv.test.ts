import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCachedKv } from './cached-kv';

// SvelteKit's $app/environment.browser is `false` under vitest — flip it
// on for these tests so the helper exercises its real path. The helper
// re-reads `browser` on every call, so the mock applies dynamically.
vi.mock('$app/environment', () => ({ browser: true }));

// Vitest defaults to the `node` environment for this project (no DOM),
// so localStorage is not defined. Mount a Map-backed shim that behaves
// like the spec's Storage interface for the slice the helper uses.
class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number { return this.store.size; }
  key(i: number): string | null {
    return [...this.store.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.store.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, String(v));
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}
// Surface as both `localStorage` and `Storage.prototype` so the
// quota-error test can spy on Storage.prototype.setItem the same way
// it would in a real browser.
const memStorage = new MemoryStorage();
(globalThis as unknown as { localStorage: Storage }).localStorage =
  memStorage as unknown as Storage;
(globalThis as unknown as { Storage: typeof MemoryStorage }).Storage = MemoryStorage;

beforeEach(() => {
  memStorage.clear();
});

describe('createCachedKv', () => {
  it('round-trips a value', () => {
    const kv = createCachedKv<{ name: string }>({ prefix: 'p', version: 'v1' });
    expect(kv.load('alice')).toBeNull();
    kv.save('alice', { name: 'Alice' });
    expect(kv.load('alice')).toEqual({ name: 'Alice' });
  });

  it('namespaces by prefix + version so different versions don\'t collide', () => {
    const kvA = createCachedKv<number>({ prefix: 'p', version: 'v1' });
    const kvB = createCachedKv<number>({ prefix: 'p', version: 'v2' });
    kvA.save('k', 1);
    kvB.save('k', 2);
    expect(kvA.load('k')).toBe(1);
    expect(kvB.load('k')).toBe(2);
  });

  it('returns null for unparseable JSON without throwing', () => {
    localStorage.setItem('p:v1:bad', '{not json');
    const kv = createCachedKv<unknown>({ prefix: 'p', version: 'v1' });
    expect(kv.load('bad')).toBeNull();
  });

  it('returns null when the envelope is missing the timestamp', () => {
    // Older callers might have written a bare value; treat as miss.
    localStorage.setItem('p:v1:legacy', JSON.stringify({ name: 'Alice' }));
    const kv = createCachedKv<{ name: string }>({ prefix: 'p', version: 'v1' });
    expect(kv.load('legacy')).toBeNull();
  });

  it('expires entries past ttlMs', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const kv = createCachedKv<string>({ prefix: 'p', version: 'v1', ttlMs: 1000 });
      kv.save('k', 'fresh');
      expect(kv.load('k')).toBe('fresh');
      vi.advanceTimersByTime(2000);
      expect(kv.load('k')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps entries forever when ttlMs is omitted', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const kv = createCachedKv<string>({ prefix: 'p', version: 'v1' });
      kv.save('k', 'forever');
      vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);
      expect(kv.load('k')).toBe('forever');
    } finally {
      vi.useRealTimers();
    }
  });

  it('trims arrays to maxItems before persisting', () => {
    const kv = createCachedKv<number[]>({ prefix: 'p', version: 'v1', maxItems: 3 });
    kv.save('list', [1, 2, 3, 4, 5]);
    expect(kv.load('list')).toEqual([1, 2, 3]);
  });

  it('leaves non-array values alone even when maxItems is set', () => {
    const kv = createCachedKv<{ items: number[] }>({ prefix: 'p', version: 'v1', maxItems: 3 });
    kv.save('k', { items: [1, 2, 3, 4, 5] });
    expect(kv.load('k')).toEqual({ items: [1, 2, 3, 4, 5] });
  });

  it('exposes the write timestamp via loadWithMeta', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-28T12:00:00Z'));
      const kv = createCachedKv<string>({ prefix: 'p', version: 'v1' });
      kv.save('k', 'x');
      const meta = kv.loadWithMeta('k');
      expect(meta?.value).toBe('x');
      expect(meta?.at).toBe(Date.UTC(2026, 3, 28, 12, 0, 0));
    } finally {
      vi.useRealTimers();
    }
  });

  it('clearAll removes only this namespace', () => {
    const kvA = createCachedKv<string>({ prefix: 'p', version: 'v1' });
    const kvB = createCachedKv<string>({ prefix: 'p', version: 'v2' });
    kvA.save('k', 'one');
    kvB.save('k', 'two');
    localStorage.setItem('unrelated', 'leave me alone');
    kvA.clearAll();
    expect(kvA.load('k')).toBeNull();
    expect(kvB.load('k')).toBe('two');
    expect(localStorage.getItem('unrelated')).toBe('leave me alone');
  });

  it('save returns false on quota error and does not throw', () => {
    const kv = createCachedKv<string>({ prefix: 'p', version: 'v1' });
    const original = localStorage.setItem.bind(localStorage);
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('Quota', 'QuotaExceededError');
      });
    try {
      expect(kv.save('k', 'v')).toBe(false);
    } finally {
      spy.mockRestore();
      // sanity: native still works
      original('k', 'v');
    }
  });
});
