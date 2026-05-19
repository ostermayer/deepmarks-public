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
import type { FeedOptions } from './feed-types.js';
import { loadCachedBookmarkFeed, saveCachedBookmarkFeed } from './feed-cache.js';

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
//   an empty state. localStorage is synchronous
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
/** Pure decision: should `incoming` replace `existing`? Exposed for testing. */
export function shouldReplace(existing: Entry, incoming: ParsedBookmark): boolean {
  const incomingReplaceTime = incoming.eventCreatedAt ?? incoming.savedAt;
  const existingReplaceTime = existing.bookmark.eventCreatedAt ?? existing.bookmark.savedAt;
  if (incomingReplaceTime > existingReplaceTime) return true;
  if (incomingReplaceTime < existingReplaceTime) return false;
  // NIP-01 tiebreaker: lexicographically larger event id wins.
  return incoming.eventId > existing.bookmark.eventId;
}

function mergeReplacement(existing: ParsedBookmark | undefined, incoming: ParsedBookmark): ParsedBookmark {
  if (existing && incoming.publishedAt === undefined && existing.savedAt < incoming.savedAt) {
    return {
      ...incoming,
      publishedAt: existing.publishedAt,
      savedAt: existing.savedAt,
      savedAtMs: existing.savedAtMs,
    };
  }
  return incoming;
}

/**
 * Attribution-preference dedup: when the Deepmarks public brand/social pubkey AND another
 * curator have both published the same URL, hide the deepmarks event so the
 * real curator gets the attribution. Pure & exhaustively tested — see
 * memory/project_attribution.md for the rule's rationale.
 *
 * `hidePubkeys` is the set of pubkeys to suppress. In practice those are
 * Deepmarks-owned editorial bookmark keys: the daily public-profile
 * importer plus the legacy admin importer key.
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
  const initial = loadCachedBookmarkFeed(opts);

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

    const hideSet = new Set(config.deepmarksEditorialPubkeys);

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
      saveCachedBookmarkFeed(opts, filtered);
    }

    let sub: NDKSubscription | null = null;
    try {
      // PARALLEL = serve cache hits immediately AND open relay subs at
      // the same time. NDK's Dexie adapter (see ndk.ts) backs the cache
      // with IndexedDB, so reload paints from disk in <50ms and live
      // events trickle in on top. No more blank first paint.
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
        byKey.set(key, { bookmark: mergeReplacement(existing?.bookmark, parsed), key });
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
