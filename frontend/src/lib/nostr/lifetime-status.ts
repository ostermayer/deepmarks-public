// Lifetime-tier membership lookup, cached per pubkey.
//
// Mirrors the shape of `profiles.ts`: a reactive store per pubkey, an
// in-memory dedup cache, and a localStorage tier so the pennant doesn't
// flicker in/out on reload while the API call is in flight.
//
// The source of truth is api's GET /account/lifetime/status,
// which reads from Redis. Negative answers (not a member) are cached
// briefly so we don't hammer the API for every feed row that shows a
// non-member curator.

import { type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import { api } from '$lib/api/client.js';
import { createCachedKv } from '$lib/util/cached-kv.js';

/** Positive results are effectively permanent — once you're a member you stay one. */
const POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Negative results expire in 10 minutes so newly-minted members light up the pennant
 *  after their webhook settles, without forcing a refetch on every render. */
const NEGATIVE_TTL_MS = 10 * 60 * 1000;

// Two caches with different TTLs. The split is per-value because the
// positive case ("yes, member") wants a long lifetime while the
// negative case ("not yet") needs to refresh quickly so a fresh
// upgrade lights up across tabs without manual reload. v2 (post-
// helper migration) replaces the v1 single-cache shape.
const positiveCache = createCachedKv<true>({
  prefix: 'deepmarks-lifetime-pos',
  version: 'v2',
  ttlMs: POSITIVE_TTL_MS,
});
const negativeCache = createCachedKv<false>({
  prefix: 'deepmarks-lifetime-neg',
  version: 'v2',
  ttlMs: NEGATIVE_TTL_MS,
});

interface CachedEntry {
  isMember: boolean;
  at: number;
}

function loadCached(pubkey: string): CachedEntry | null {
  const pos = positiveCache.loadWithMeta(pubkey);
  if (pos) return { isMember: true, at: pos.at };
  const neg = negativeCache.loadWithMeta(pubkey);
  if (neg) return { isMember: false, at: neg.at };
  return null;
}

function saveCached(pubkey: string, isMember: boolean): void {
  if (isMember) positiveCache.save(pubkey, true);
  else negativeCache.save(pubkey, false);
}

type LifetimeValue = boolean | null;

interface LifetimeStore extends Readable<LifetimeValue> {
  __set(v: LifetimeValue): void;
}

const cache = new Map<string, LifetimeStore>();

function createStore(initial: LifetimeValue): LifetimeStore {
  let current = initial;
  const subs = new Set<(v: LifetimeValue) => void>();
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

/** Returns a reactive store for lifetime status. It emits null until the
 *  server has answered unless a local cache can seed the value. */
export function getLifetimeStatus(pubkey: string): Readable<LifetimeValue> {
  const hit = cache.get(pubkey);
  if (hit) return hit;

  const cached = loadCached(pubkey);
  const store = createStore(cached?.isMember ?? null);
  cache.set(pubkey, store);

  // Background-refresh positive cache entries rarely (they seldom change);
  // always refetch on a negative cache miss so fresh payments light up
  // quickly after the BTCPay webhook settles.
  const skipFetch = cached?.isMember === true && Date.now() - cached.at < POSITIVE_TTL_MS / 2;
  if (!skipFetch && browser) {
    setTimeout(() => {
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
    }, 0);
  }

  return store;
}

/** One-shot lifetime check for non-component flows such as native share-drain.
 * Uses the same local cache policy as getLifetimeStatus, then refreshes the
 * shared store/cache when the API can answer. */
export async function isLifetimeMemberOnce(pubkey: string): Promise<boolean> {
  const cached = loadCached(pubkey);
  if (cached?.isMember && Date.now() - cached.at < POSITIVE_TTL_MS) return true;
  try {
    const res = await api.lifetime.status(pubkey);
    setLifetimeStatus(pubkey, res.isLifetimeMember);
    return res.isLifetimeMember;
  } catch {
    return cached?.isMember ?? false;
  }
}

/** Drop a single pubkey from the cache — used after a successful upgrade so
 *  the local UI flips to "member" without waiting for a TTL. */
export function invalidateLifetimeStatus(pubkey: string): void {
  cache.delete(pubkey);
  positiveCache.remove(pubkey);
  negativeCache.remove(pubkey);
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
