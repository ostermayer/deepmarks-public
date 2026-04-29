// Lifetime-tier membership lookup, cached per pubkey.
//
// Mirrors the shape of `profiles.ts`: a reactive store per pubkey, an
// in-memory dedup cache, and a localStorage tier so the pennant doesn't
// flicker in/out on reload while the API call is in flight.
//
// The source of truth is payment-proxy's GET /account/lifetime/status,
// which reads from Redis. Negative answers (not a member) are cached
// briefly so we don't hammer the API for every feed row that shows a
// non-member curator.

import { readable, type Readable } from 'svelte/store';
import { api } from '$lib/api/client.js';

const LS_PREFIX = 'deepmarks-lifetime:v1:';
/** Positive results are effectively permanent — once you're a member you stay one. */
const POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Negative results expire in 10 minutes so newly-minted members light up the pennant
 *  after their webhook settles, without forcing a refetch on every render. */
const NEGATIVE_TTL_MS = 10 * 60 * 1000;

interface CachedEntry {
  isMember: boolean;
  at: number;
}

function lsKey(pubkey: string): string {
  return LS_PREFIX + pubkey;
}

function loadCached(pubkey: string): CachedEntry | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(lsKey(pubkey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedEntry;
    if (typeof parsed.isMember !== 'boolean' || typeof parsed.at !== 'number') return null;
    const ttl = parsed.isMember ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - parsed.at > ttl) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCached(pubkey: string, isMember: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(lsKey(pubkey), JSON.stringify({ isMember, at: Date.now() }));
  } catch {
    // Private browsing / quota — tolerable.
  }
}

interface LifetimeStore extends Readable<boolean> {
  __set(v: boolean): void;
}

const cache = new Map<string, LifetimeStore>();

function createStore(initial: boolean): LifetimeStore {
  let current = initial;
  const subs = new Set<(v: boolean) => void>();
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

/** Returns a reactive store that emits true once the given pubkey is confirmed
 *  as a lifetime member. Falsy until proven otherwise; never throws. */
export function getLifetimeStatus(pubkey: string): Readable<boolean> {
  const hit = cache.get(pubkey);
  if (hit) return hit;

  const cached = loadCached(pubkey);
  const store = createStore(cached?.isMember ?? false);
  cache.set(pubkey, store);

  // Background-refresh positive cache entries rarely (they seldom change);
  // always refetch on a negative cache miss so fresh payments light up
  // quickly after the BTCPay webhook settles.
  const skipFetch = cached?.isMember === true && Date.now() - cached.at < POSITIVE_TTL_MS / 2;
  if (!skipFetch) {
    void api.lifetime
      .status(pubkey)
      .then((res) => {
        store.__set(res.isLifetimeMember);
        saveCached(pubkey, res.isLifetimeMember);
      })
      .catch(() => {
        // API down / CORS / whatever — stay at the seeded value. No badge
        // is a better failure mode than a wrong badge.
      });
  }

  return store;
}

/** Drop a single pubkey from the cache — used after a successful upgrade so
 *  the local UI flips to "member" without waiting for a TTL. */
export function invalidateLifetimeStatus(pubkey: string): void {
  cache.delete(pubkey);
  if (typeof localStorage !== 'undefined') {
    try { localStorage.removeItem(lsKey(pubkey)); } catch { /* ignore */ }
  }
}

/** Write an authoritative status straight into the shared store — e.g. after
 *  the /app/upgrade page polls settlement and wants every other badge on the
 *  page to flip without waiting for its own refetch. */
export function setLifetimeStatus(pubkey: string, isMember: boolean): void {
  const existing = cache.get(pubkey);
  if (existing) {
    existing.__set(isMember);
  } else {
    const store = createStore(isMember);
    cache.set(pubkey, store);
  }
  saveCached(pubkey, isMember);
}
