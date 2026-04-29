// Live subscription helper — yields a Svelte-readable store of ParsedBookmark[]
// updated as kind:39701 events arrive. Stored events are deduped by `d`-tag
// (URL) per author, keeping the freshest version per (curator, url) pair.
// Ties in `created_at` are broken by event id (lexicographically larger wins),
// matching NIP-01's replaceable-event resolution.

import { readable, type Readable } from 'svelte/store';
import {
  NDKEvent,
  NDKSubscriptionCacheUsage,
  type NDKFilter,
  type NDKKind,
  type NDKSubscription
} from '@nostr-dev-kit/ndk';
import { getNdk } from './ndk.js';
import { KIND } from './kinds.js';
import { parseBookmarkEvent, type ParsedBookmark, type SignedEventLike } from './bookmarks.js';
import { mutedPubkeys } from './mute-list.js';
import { config } from '$lib/config.js';

export interface FeedOptions {
  /** Restrict to bookmarks signed by these pubkeys. */
  authors?: string[];
  /** Tag filter (NIP-12 #t). */
  tags?: string[];
  /** d-tag filter — kind:39701 is parameterized by URL via the `d` tag,
   *  so this restricts to one (or several) specific URLs. Used by the
   *  /app/url/[url] page to show every saver of the same link. */
  urls?: string[];
  /** Soft limit for initial load; the live feed continues past this. */
  limit?: number;
}

interface Entry {
  bookmark: ParsedBookmark;
  /** Composite dedup key: pubkey + URL. */
  key: string;
}

function dedupKey(pubkey: string, url: string): string {
  return `${pubkey}::${url}`;
}

// ── Cache (two-tier) ───────────────────────────────────────────────────
//
// Tier 1: localStorage prime (synchronous, ~5ms)
//   The Dexie cache below is fast (~50-200ms) but its query is async
//   IndexedDB — by the time it resolves, Svelte has already painted
//   an empty 'listening to relays…' state. localStorage is synchronous
//   and feeds the readable's INITIAL state, so the user sees their
//   bookmarks before the first paint commits. Capped at 200 entries
//   per filter; quota errors fall through silently.
//
// Tier 2: NDK Dexie cache (async, persistent, larger)
//   Configured in lib/nostr/ndk.ts. Persists every kind:39701 +
//   replaceable event NDK has seen across sessions. PARALLEL
//   subscription mode pulls cache hits AND opens the live relay
//   subscription at once, so updates flow in over the localStorage
//   prime as the cache resolves. Replaceable events (kind:0/30003/
//   10002/etc) are auto-superseded.
const LS_PREFIX = 'deepmarks-feed-cache:v2:';
const LS_MAX_ENTRIES = 200;

function lsKey(opts: FeedOptions): string {
  return LS_PREFIX + JSON.stringify({
    a: opts.authors ? [...opts.authors].sort() : null,
    t: opts.tags ? [...opts.tags].sort() : null,
    u: opts.urls ? [...opts.urls].sort() : null,
    l: opts.limit ?? 200,
  });
}

function lsLoad(key: string): ParsedBookmark[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ParsedBookmark[]) : [];
  } catch {
    return [];
  }
}

function lsSave(key: string, list: ParsedBookmark[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(0, LS_MAX_ENTRIES)));
  } catch {
    // Quota / private mode — Dexie still has the data; sync prime
    // just won't fire next refresh.
  }
}

/** Pure decision: should `incoming` replace `existing`? Exposed for testing. */
export function shouldReplace(existing: Entry, incoming: ParsedBookmark): boolean {
  if (incoming.savedAt > existing.bookmark.savedAt) return true;
  if (incoming.savedAt < existing.bookmark.savedAt) return false;
  // NIP-01 tiebreaker: lexicographically larger event id wins.
  return incoming.eventId > existing.bookmark.eventId;
}

/**
 * Attribution-preference dedup: when the deepmarks brand pubkey AND another
 * curator have both published the same URL, hide the deepmarks event so the
 * real curator gets the attribution. Pure & exhaustively tested — see
 * memory/project_attribution.md for the rule's rationale.
 *
 * `hidePubkeys` is the set of pubkeys to suppress. In practice that's just
 * `[config.deepmarksPubkey]`, but the parameter is generic so a future
 * "boost certain accounts" filter could reuse the same machinery.
 */
export function applyAttributionPreference(
  bookmarks: ParsedBookmark[],
  hidePubkeys: Set<string>,
): ParsedBookmark[] {
  if (hidePubkeys.size === 0) return bookmarks;
  const urlsCoveredByOthers = new Set<string>();
  for (const b of bookmarks) {
    if (!hidePubkeys.has(b.curator)) urlsCoveredByOthers.add(b.url);
  }
  return bookmarks.filter(
    (b) => !hidePubkeys.has(b.curator) || !urlsCoveredByOthers.has(b.url),
  );
}

export function createBookmarkFeed(opts: FeedOptions = {}): Readable<ParsedBookmark[]> {
  // Synchronous prime from localStorage. Runs at readable() construction
  // BEFORE the start callback fires, so the store's first emit is the
  // cached list rather than []. Eliminates the empty-state flash on
  // refresh — the user sees yesterday's bookmarks, then NDK + relays
  // top them up within a tick or two.
  const cacheKey = lsKey(opts);
  const initial = lsLoad(cacheKey);

  return readable<ParsedBookmark[]>(initial, (set) => {
    const ndk = getNdk();
    const filter: NDKFilter = {
      // NDKKind enum doesn't list 39701 (NIP-B0 is not in NDK's defaults yet).
      kinds: [KIND.webBookmark as unknown as NDKKind],
      limit: opts.limit ?? 200
    };
    if (opts.authors?.length) filter.authors = opts.authors;
    if (opts.tags?.length) (filter as NDKFilter & { '#t'?: string[] })['#t'] = opts.tags;
    if (opts.urls?.length) (filter as NDKFilter & { '#d'?: string[] })['#d'] = opts.urls;

    // Prime byKey from the cached initial list so events that arrive
    // from the relay merge into the existing set rather than replacing
    // it. Without this the first relay event would collapse the store
    // back to a one-entry list.
    const byKey = new Map<string, Entry>();
    for (const b of initial) {
      byKey.set(dedupKey(b.curator, b.url), { bookmark: b, key: dedupKey(b.curator, b.url) });
    }

    const hideSet = config.deepmarksPubkey
      ? new Set([config.deepmarksPubkey])
      : new Set<string>();

    // Live mute-list snapshot. Subscribing here means a mute action
    // anywhere in the app re-emits the feed without needing to
    // tear-down + re-subscribe. Initial value is the empty set; the
    // store fills in once loadMuteList runs.
    let mutedSnapshot = new Set<string>();
    const unsubMutes = mutedPubkeys.subscribe((next) => {
      mutedSnapshot = next;
      emit();
    });

    function emit() {
      const raw = Array.from(byKey.values()).map((e) => e.bookmark);
      const afterAttribution = applyAttributionPreference(raw, hideSet);
      const filtered = mutedSnapshot.size === 0
        ? afterAttribution
        : afterAttribution.filter((b) => !mutedSnapshot.has(b.curator));
      filtered.sort((a, b) => b.savedAt - a.savedAt);
      set(filtered);
      // Persist back to localStorage so the next refresh primes
      // synchronously with this state. lsSave is best-effort and
      // capped — quota errors are silent.
      lsSave(cacheKey, filtered);
    }

    let sub: NDKSubscription | null = null;
    try {
      // PARALLEL = serve cache hits immediately AND open relay subs at
      // the same time. NDK's Dexie adapter (see ndk.ts) backs the cache
      // with IndexedDB, so reload paints from disk in <50ms and live
      // events trickle in on top. No more empty "listening to relays…"
      // flash on cold start.
      sub = ndk.subscribe(filter, {
        closeOnEose: false,
        cacheUsage: NDKSubscriptionCacheUsage.PARALLEL,
      });
      sub.on('event', (event: NDKEvent) => {
        // NDKEvent is shape-compatible with SignedEventLike for our parser's needs.
        const parsed = parseBookmarkEvent(event as unknown as SignedEventLike);
        if (!parsed) return;
        const key = dedupKey(parsed.curator, parsed.url);
        const existing = byKey.get(key);
        if (existing && !shouldReplace(existing, parsed)) return;
        byKey.set(key, { bookmark: parsed, key });
        emit();
      });
    } catch (e) {
      // Pool not connected yet on first paint. The subscription is recreated
      // on the next route change (Svelte unsubscribes / resubscribes), so
      // logging is enough — no further action needed on this path.
      console.warn('Feed subscription failed:', e);
    }

    return () => {
      sub?.stop();
      unsubMutes();
    };
  });
}
