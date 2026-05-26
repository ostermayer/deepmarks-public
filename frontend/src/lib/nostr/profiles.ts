// NIP-01 kind:0 profile metadata — fetched on demand, cached in-memory,
// exposed as Svelte stores so any component reactively re-renders when a
// profile lands.
//
// We deliberately do NOT cross-validate the picture URL against image
// sniffing or content-type — that would require fetching the image with our
// IP. Render-time `<img onerror>` is enough to gate broken links.

import { get, readable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import { createCachedKv } from '$lib/util/cached-kv.js';

export interface Profile {
  pubkey: string;
  /** Best handle to render: name (short) → display_name (longer) → trimmed-npub fallback (caller adds the npub). */
  displayName?: string;
  name?: string;
  picture?: string;
  about?: string;
  lud16?: string; // Lightning address
  lud06?: string; // LNURL-pay bech32
  nip05?: string;
  website?: string;
}

export function profileLightningAddress(profile: Pick<Profile, 'lud16' | 'lud06'> | null | undefined): string | null {
  return profile?.lud16 ?? profile?.lud06 ?? null;
}

/**
 * Parse the JSON content of a kind:0 event. Returns a partial Profile or
 * null when the content isn't valid JSON. Tolerant of unknown fields and
 * missing values — never throws on user-supplied data.
 */
export function parseProfileContent(content: string, pubkey: string): Profile | null {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  const str = (k: string): string | undefined => {
    const v = obj[k];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  const picture = str('picture');
  return {
    pubkey,
    name: str('name'),
    displayName: str('name') ?? str('display_name') ?? str('displayName'),
    picture: isLikelyImageUrl(picture) ? picture : undefined,
    about: str('about'),
    lud16: str('lud16') ?? str('lightning_address'),
    lud06: str('lud06'),
    nip05: str('nip05'),
    website: str('website')
  };
}

/**
 * Light validation — picture must be an http(s) URL. We deliberately don't
 * try to verify it returns an image; the <img> tag's onerror handles that
 * at render time without our server ever fetching the URL.
 */
export function isLikelyImageUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── Cache + reactive lookup ────────────────────────────────────────────
//
// Two tiers:
//   1. In-memory Map<pubkey, store> — dedups lookups within a session.
//   2. localStorage — survives reloads so rows paint the display name on
//      first paint instead of flashing the truncated npub while a kind:0
//      roundtrip completes. Each entry is keyed by pubkey and stored
//      independently so we don't rewrite a huge blob on every update.

interface CacheEntry {
  store: ReturnType<typeof createProfileStore>;
  promise: Promise<void>;
}

// Two-tier cache:
//   1. In-memory store map — dedups concurrent getProfile calls in
//      the same session.
//   2. localStorage prime — synchronous read at getProfile() time so
//      the avatar / display name paint with the correct values
//      instead of flashing the npub fallback while NDK opens Dexie.
//
// Long-term storage of the actual kind:0 events still lives in the
// NDK Dexie cache; the localStorage prime is just the just-the-fields
// projection needed for instant paint.
//
// Bumped to v4 when the inline lsLoad/lsSave were replaced with
// createCachedKv — the helper wraps values in { v, at } envelopes
// which the older v3 raw-blob entries don't match. v3 entries are
// treated as misses and re-fetched.
const cache = new Map<string, CacheEntry>();
const profileCache = createCachedKv<Profile>({ prefix: 'deepmarks-profile', version: 'v4' });

/** Returns a cached reactive store for the given pubkey, fetching if needed. */
export function getProfile(pubkey: string): Readable<Profile | null> {
  const hit = cache.get(pubkey);
  if (hit) return hit.store;

  const store = createProfileStore(pubkey);
  // Synchronous prime so the first paint already has display_name +
  // picture for cached profiles.
  const persisted = profileCache.load(pubkey);
  if (persisted) store.__set(persisted);
  const promise = (browser ? deferProfileFetch(pubkey, store) : fetchAndPopulate(pubkey, store)).catch(() => {
    // Swallow — the store stays at the cached / null value.
  });
  cache.set(pubkey, { store, promise });
  return store;
}

/** Resolve the cached/fetching profile once, useful for click-time decisions. */
export async function resolveProfile(pubkey: string): Promise<Profile | null> {
  const store = getProfile(pubkey);
  const current = get(store);
  if (current) return current;
  await cache.get(pubkey)?.promise.catch(() => undefined);
  return get(store);
}

/**
 * Force a refresh after the owner has published a new kind:0. NDK's
 * Dexie adapter handles eviction of the older kind:0 — replaceable
 * events are superseded automatically when a newer-created_at version
 * arrives. We also wipe the localStorage prime so the next cold
 * getProfile reads fresh data.
 */
export function invalidateProfile(pubkey: string): void {
  profileCache.remove(pubkey);
  const hit = cache.get(pubkey);
  if (hit) {
    const promise = fetchAndPopulate(pubkey, hit.store).catch(() => { /* ignore */ });
    cache.set(pubkey, { store: hit.store, promise });
    return;
  }
  cache.delete(pubkey);
}

/** Test-only: reset the entire cache. */
export function __resetProfileCacheForTests(): void {
  cache.clear();
}

interface ProfileStore extends Readable<Profile | null> {
  __set(p: Profile | null): void;
}

function createProfileStore(_pubkey: string): ProfileStore {
  let current: Profile | null = null;
  const subs = new Set<(value: Profile | null) => void>();
  const store: ProfileStore = {
    subscribe(run) {
      subs.add(run);
      run(current);
      return () => subs.delete(run);
    },
    __set(p) {
      current = p;
      for (const fn of subs) fn(current);
    }
  };
  // Mirror readable() shape so callers can $-bind without surprise.
  void readable; // keep import alive for future readable-based variant
  return store;
}

function deferProfileFetch(pubkey: string, store: ProfileStore): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      fetchAndPopulate(pubkey, store).then(resolve, reject);
    }, 0);
  });
}

async function fetchAndPopulate(pubkey: string, store: ProfileStore): Promise<void> {
  // Fast path: Deepmarks server profile cache. Returns immediately
  // with cached kind:0 data (~50ms typical) without opening a fresh
  // relay subscription. Falls through to NDK on miss or error so the
  // store still resolves for pubkeys the server hasn't seen.
  const fromServer = await fetchProfileFromServer(pubkey).catch(() => null);
  if (fromServer) {
    store.__set(fromServer);
    profileCache.save(pubkey, fromServer);
    return;
  }

  const { getNdk } = await import('./ndk.js');
  const ndk = getNdk();
  const event = await ndk.fetchEvent({ kinds: [0], authors: [pubkey] });
  if (!event) return;
  const profile = parseProfileContent(event.content, pubkey);
  store.__set(profile);
  if (profile) profileCache.save(pubkey, profile);
}

async function fetchProfileFromServer(pubkey: string): Promise<Profile | null> {
  if (!browser) return null;
  const { config } = await import('$lib/config.js');
  const url = `${config.apiBase.replace(/\/$/, '')}/profile/${pubkey}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json' },
      // 1.5s timeout — the server itself already times out the relay
      // hop, so we don't want to wait longer than that.
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  if (obj.updatedAt === null) return null; // server says no kind:0 found
  const str = (k: string): string | undefined => {
    const v = obj[k];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  const picture = str('picture');
  return {
    pubkey,
    name: str('name'),
    displayName: str('name') ?? str('display_name') ?? str('displayName'),
    picture: isLikelyImageUrl(picture) ? picture : undefined,
    about: str('about'),
    lud16: str('lud16') ?? str('lightning_address'),
    lud06: str('lud06'),
    nip05: str('nip05'),
    website: str('website'),
  };
}
