// NIP-01 kind:0 profile metadata — fetched on demand, cached in-memory,
// exposed as Svelte stores so any component reactively re-renders when a
// profile lands.
//
// We deliberately do NOT cross-validate the picture URL against image
// sniffing or content-type — that would require fetching the image with our
// IP. Render-time `<img onerror>` is enough to gate broken links.

import { readable, type Readable } from 'svelte/store';
import { getNdk } from './ndk.js';

export interface Profile {
  pubkey: string;
  /** Best handle to render: name (short) → display_name (longer) → trimmed-npub fallback (caller adds the npub). */
  displayName?: string;
  name?: string;
  picture?: string;
  about?: string;
  lud16?: string; // Lightning address
  nip05?: string;
  website?: string;
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
const cache = new Map<string, CacheEntry>();
const PROFILE_LS_PREFIX = 'deepmarks-profile:v3:';

function lsLoadProfile(pubkey: string): Profile | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(PROFILE_LS_PREFIX + pubkey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Profile) : null;
  } catch { return null; }
}

function lsSaveProfile(pubkey: string, profile: Profile | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (profile) localStorage.setItem(PROFILE_LS_PREFIX + pubkey, JSON.stringify(profile));
  } catch { /* quota */ }
}

/** Returns a cached reactive store for the given pubkey, fetching if needed. */
export function getProfile(pubkey: string): Readable<Profile | null> {
  const hit = cache.get(pubkey);
  if (hit) return hit.store;

  const store = createProfileStore(pubkey);
  // Synchronous prime so the first paint already has display_name +
  // picture for cached profiles.
  const persisted = lsLoadProfile(pubkey);
  if (persisted) store.__set(persisted);
  const promise = fetchAndPopulate(pubkey, store).catch(() => {
    // Swallow — the store stays at the cached / null value.
  });
  cache.set(pubkey, { store, promise });
  return store;
}

/**
 * Force a refresh after the owner has published a new kind:0. NDK's
 * Dexie adapter handles eviction of the older kind:0 — replaceable
 * events are superseded automatically when a newer-created_at version
 * arrives. We also wipe the localStorage prime so the next cold
 * getProfile reads fresh data.
 */
export function invalidateProfile(pubkey: string): void {
  if (typeof localStorage !== 'undefined') {
    try { localStorage.removeItem(PROFILE_LS_PREFIX + pubkey); } catch { /* ignore */ }
  }
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

async function fetchAndPopulate(pubkey: string, store: ProfileStore): Promise<void> {
  const ndk = getNdk();
  const event = await ndk.fetchEvent({ kinds: [0], authors: [pubkey] });
  if (!event) return;
  const profile = parseProfileContent(event.content, pubkey);
  store.__set(profile);
  lsSaveProfile(pubkey, profile);
}
