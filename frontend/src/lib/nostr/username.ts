// Short-handle cache — parallels profiles.ts but for the lifetime-tier
// deepmarks handle. One handle per pubkey (or none). Fetched lazily on
// the first getUsername(pubkey) call; results are kept in-memory + mirrored
// into localStorage so returning visitors see the handle on first paint.
//
// Null = "looked up, no handle claimed". We store the null answer too so
// non-lifetime users don't re-hit the API on every page view.

import { readable, type Readable } from 'svelte/store';
import { api, ApiError } from '$lib/api/client';

const LS_PREFIX = 'deepmarks-username:v1:';
const NEGATIVE_TTL_MS = 5 * 60 * 1000; // keep misses for 5 min before re-asking
/** Positive cache: handles rarely change, so once we have one we can
 *  hold it for a while without hitting the API again. A returning
 *  visitor paints the handle immediately from localStorage and we only
 *  re-verify after this window elapses. */
const POSITIVE_TTL_MS = 10 * 60 * 1000;

interface Entry {
  name: string | null;
  at: number;
}

interface CacheSlot {
  store: UsernameStoreLike;
  loaded: Promise<void>;
}

interface UsernameStoreLike extends Readable<string | null> {
  __set(name: string | null): void;
}

const cache = new Map<string, CacheSlot>();

export function getUsername(pubkey: string): Readable<string | null> {
  const hit = cache.get(pubkey);
  if (hit) return hit.store;
  const store = createStore();
  const seeded = readPersisted(pubkey);
  if (seeded) store.__set(seeded.name);
  const loaded = fetchAndPopulate(pubkey, store, seeded).catch(() => {
    // Swallow — store stays at seeded / null.
  });
  cache.set(pubkey, { store, loaded });
  return store;
}

/**
 * Force a refresh after the user changes/releases their own handle. Keeps
 * the existing store so any mounted components stay live; refetches into
 * it. localStorage copy is cleared so cold paints also see fresh data.
 */
export function invalidateUsername(pubkey: string): void {
  if (typeof localStorage !== 'undefined') {
    try { localStorage.removeItem(LS_PREFIX + pubkey); } catch { /* ignore */ }
  }
  const hit = cache.get(pubkey);
  if (hit) {
    const loaded = fetchAndPopulate(pubkey, hit.store, null).catch(() => { /* ignore */ });
    cache.set(pubkey, { store: hit.store, loaded });
    return;
  }
  cache.delete(pubkey);
}

function createStore(): UsernameStoreLike {
  let current: string | null = null;
  const subs = new Set<(v: string | null) => void>();
  void readable; // keep import alive
  return {
    subscribe(run) {
      subs.add(run);
      run(current);
      return () => subs.delete(run);
    },
    __set(v) {
      current = v;
      for (const fn of subs) fn(v);
    },
  };
}

function readPersisted(pubkey: string): Entry | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LS_PREFIX + pubkey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Entry;
    if (typeof parsed.at !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePersisted(pubkey: string, name: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LS_PREFIX + pubkey, JSON.stringify({ name, at: Date.now() }));
  } catch { /* quota — tolerable */ }
}

async function fetchAndPopulate(
  pubkey: string,
  store: UsernameStoreLike,
  seeded: Entry | null,
): Promise<void> {
  if (seeded) {
    const age = Date.now() - seeded.at;
    // Fresh-ish negative or positive cache — skip the API hit. Matters
    // most for feeds that render many curators at once: without the
    // positive gate we'd fire one request per pubkey on every page load.
    if (seeded.name === null && age < NEGATIVE_TTL_MS) return;
    if (seeded.name !== null && age < POSITIVE_TTL_MS) return;
  }
  try {
    const res = await api.username.ofPubkey(pubkey);
    store.__set(res.name);
    writePersisted(pubkey, res.name);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      store.__set(null);
      writePersisted(pubkey, null);
      return;
    }
    // Any other error leaves the seeded value in place.
  }
}
