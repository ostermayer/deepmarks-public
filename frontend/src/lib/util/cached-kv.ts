// Tiny localStorage helper for the three-tier cache pattern.
//
// Every consumer of NDK-cached data on this site (feed, profile, my-zaps,
// my-archives, private-bookmark snapshot, lifetime-status, …) shares the
// same shape: synchronous prime from localStorage so the page paints with
// yesterday's data, then NDK Dexie + a live relay subscription update it.
// The localStorage half of that pattern was independently re-implemented
// in seven places — same try/JSON.parse, same try/setItem-on-quota, same
// SSR `typeof localStorage` guard, with subtly different key shapes.
//
// This helper concentrates the storage half so the consumers can stay
// focused on their actual logic (filter, parse, dedup, emit).
//
// Design:
//  - Prefix + version → `${prefix}:${version}:`. Bump version to invalidate.
//  - Optional TTL — set when entries should expire (e.g. negative caches).
//    If unset, entries live until the user clears storage. Per-entry
//    timestamps are stored alongside the value, never inferred from the
//    write time.
//  - Optional `maxItems` for array values — when set, save() trims the
//    array before persisting so a long feed doesn't blow localStorage's
//    ~5MB quota. Dexie still keeps everything; the trim only affects
//    the synchronous prime.
//  - SSR-safe: every method short-circuits to a no-op / null when
//    `localStorage` isn't defined (SvelteKit pre-render).
//  - Quota errors are silent: the call returns false but does not throw
//    so callers don't have to wrap save() in a try/catch every time.
//
// Not in scope here: the NDK subscription itself, dedup logic, sort,
// store wiring. Those vary too much across consumers to abstract
// without contortions; this layer only owns "read/write a typed blob
// to localStorage with TTL + quota safety".

import { browser } from '$app/environment';

interface CachedEnvelope<T> {
  v: T;
  /** Wall-clock millisecond timestamp at write. Always present, even
   *  when no TTL is configured — lets the consumer expose `staleAt`
   *  via load() if they want to render "last updated …" copy. */
  at: number;
}

export interface CachedKvOptions {
  /** Namespace key prefix, e.g. `'deepmarks-feed-cache'`. Required. */
  prefix: string;
  /** Cache version, e.g. `'v2'`. Bump to invalidate every existing entry. */
  version: string;
  /** Time-to-live in milliseconds. Entries older than this are treated
   *  as a cache miss (load returns null). Omit for no expiry. */
  ttlMs?: number;
  /** When values are arrays, cap to this many entries before persisting.
   *  Has no effect on non-array values. */
  maxItems?: number;
}

export interface CachedKv<T> {
  /** Returns the parsed value, or null on miss / parse error / TTL expired. */
  load(key: string): T | null;
  /** Returns the raw envelope including its write timestamp. Null on miss. */
  loadWithMeta(key: string): { value: T; at: number } | null;
  /** Persists `value`. Returns true on success, false on quota / private-mode. */
  save(key: string, value: T): boolean;
  /** Removes the key. No-op if it doesn't exist. */
  remove(key: string): void;
  /** Removes every entry under this prefix+version. Useful for "sign out". */
  clearAll(): void;
}

export function createCachedKv<T>(opts: CachedKvOptions): CachedKv<T> {
  const ns = `${opts.prefix}:${opts.version}:`;

  function fullKey(k: string): string {
    return ns + k;
  }

  function load(key: string): T | null {
    return loadWithMeta(key)?.value ?? null;
  }

  function loadWithMeta(key: string): { value: T; at: number } | null {
    if (!browser) return null;
    let raw: string | null;
    try {
      raw = localStorage.getItem(fullKey(key));
    } catch {
      return null;
    }
    if (!raw) return null;
    let parsed: CachedEnvelope<T>;
    try {
      parsed = JSON.parse(raw) as CachedEnvelope<T>;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.at !== 'number') {
      return null;
    }
    if (opts.ttlMs !== undefined && Date.now() - parsed.at > opts.ttlMs) {
      // Don't bother removing here — let it sit and be overwritten by the
      // next save(). Removal would force a write on every read miss.
      return null;
    }
    return { value: parsed.v, at: parsed.at };
  }

  function save(key: string, value: T): boolean {
    if (!browser) return false;
    const trimmed =
      opts.maxItems !== undefined && Array.isArray(value)
        ? (value.slice(0, opts.maxItems) as unknown as T)
        : value;
    const envelope: CachedEnvelope<T> = { v: trimmed, at: Date.now() };
    try {
      localStorage.setItem(fullKey(key), JSON.stringify(envelope));
      return true;
    } catch {
      // Quota / private-mode Safari / disabled storage — silent.
      return false;
    }
  }

  function remove(key: string): void {
    if (!browser) return;
    try {
      localStorage.removeItem(fullKey(key));
    } catch {
      /* private mode */
    }
  }

  function clearAll(): void {
    if (!browser) return;
    try {
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(ns)) toRemove.push(k);
      }
      for (const k of toRemove) localStorage.removeItem(k);
    } catch {
      /* private mode */
    }
  }

  return { load, loadWithMeta, save, remove, clearAll };
}
