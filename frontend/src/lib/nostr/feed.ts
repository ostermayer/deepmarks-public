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
import {
  compareBookmarksNewest,
  parseBookmarkEvent,
  type ParsedBookmark,
  type SignedEventLike,
} from './bookmarks.js';
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
  // NIP-01 tiebreaker: on equal created_at the LOWEST id is retained —
  // that is the copy relays (strfry included) keep and serve, so the
  // client must pick the same winner or devices render different state.
  return incoming.eventId < existing.bookmark.eventId;
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
      kinds: [KIND.webBookmark as unknown as NDKKind, KIND.deletion as unknown as NDKKind],
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
    const deletionMemory = createBookmarkDeletionMemory();
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
      filtered.sort(compareBookmarksNewest);
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
        if (event.kind === KIND.deletion) {
          const observed = rememberBookmarkDeletion(deletionMemory, event as unknown as SignedEventLike);
          if (applyBookmarkDeletion(byKey, event as unknown as SignedEventLike)) emit();
          notifyDeletionObservers(observed);
          return;
        }
        // NDKEvent is shape-compatible with SignedEventLike for our parser's needs.
        const parsed = parseBookmarkEvent(event as unknown as SignedEventLike);
        if (!parsed) return;
        // Arrival-order guard: a copy older than a deletion we've already
        // seen this session must not resurrect the bookmark.
        if (deletionMemoryCovers(deletionMemory, parsed)) return;
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

/** Session memory of kind:5 deletions keyed by (curator, url) coordinate.
 *  Without it the feed is arrival-order sensitive: a 39701 copy arriving
 *  AFTER its own deletion (multi-relay ordering, Dexie cache replay) is
 *  re-inserted and persisted — the deleted bookmark resurrects in the UI. */
export interface BookmarkDeletionMemory {
  byCoordinate: Map<string, number>;
}

export function createBookmarkDeletionMemory(): BookmarkDeletionMemory {
  return { byCoordinate: new Map() };
}

export interface ObservedBookmarkDeletion {
  pubkey: string;
  url: string;
  deletedAt: number;
}

/** Record a deletion's kind:39701 a-tag coordinates. Returns the newly
 *  observed (pubkey, url, deletedAt) tuples so callers can propagate
 *  them to other stores (server-cache pruning in own-bookmarks). */
export function rememberBookmarkDeletion(
  memory: BookmarkDeletionMemory,
  deletion: SignedEventLike,
): ObservedBookmarkDeletion[] {
  const observed: ObservedBookmarkDeletion[] = [];
  if (deletion.kind !== KIND.deletion) return observed;
  for (const tag of deletion.tags) {
    if (tag[0] !== 'a' || typeof tag[1] !== 'string') continue;
    const [kind, pubkey, ...rest] = tag[1].split(':');
    if (kind !== String(KIND.webBookmark)) continue;
    const url = rest.join(':');
    if (!pubkey || !url) continue;
    // NIP-09: only the author may delete their own events.
    if (pubkey.toLowerCase() !== deletion.pubkey.toLowerCase()) continue;
    const key = dedupKey(pubkey, url);
    const previous = memory.byCoordinate.get(key) ?? 0;
    if (deletion.created_at > previous) {
      memory.byCoordinate.set(key, deletion.created_at);
      observed.push({ pubkey, url, deletedAt: deletion.created_at });
    }
  }
  return observed;
}

/** True when a bookmark is covered by a remembered deletion — i.e. the
 *  deletion is at least as new as the bookmark copy. A genuinely newer
 *  re-save of the same URL wins over the old deletion. */
export function deletionMemoryCovers(
  memory: BookmarkDeletionMemory,
  bookmark: ParsedBookmark,
): boolean {
  const deletedAt = memory.byCoordinate.get(dedupKey(bookmark.curator, bookmark.url));
  if (deletedAt === undefined) return false;
  return deletedAt >= (bookmark.eventCreatedAt ?? bookmark.savedAt);
}

const deletionObservers = new Set<(deletion: ObservedBookmarkDeletion) => void>();

/** Subscribe to own/other-curator bookmark deletions observed by any
 *  live feed. own-bookmarks uses this to prune its server-cache merge
 *  (which is otherwise merge-only-never-remove). */
export function onBookmarkDeletionObserved(
  cb: (deletion: ObservedBookmarkDeletion) => void,
): () => void {
  deletionObservers.add(cb);
  return () => deletionObservers.delete(cb);
}

function notifyDeletionObservers(deletions: ObservedBookmarkDeletion[]): void {
  for (const deletion of deletions) {
    for (const cb of deletionObservers) {
      try { cb(deletion); } catch { /* observer errors must not break the feed */ }
    }
  }
}

export function applyBookmarkDeletion(byKey: Map<string, Entry>, deletion: SignedEventLike): boolean {
  if (deletion.kind !== KIND.deletion) return false;
  let changed = false;
  const eTargets = new Set(
    deletion.tags
      .filter((tag) => tag[0] === 'e' && typeof tag[1] === 'string')
      .map((tag) => tag[1]),
  );

  for (const tag of deletion.tags) {
    if (tag[0] !== 'a' || typeof tag[1] !== 'string') continue;
    const [kind, pubkey, ...rest] = tag[1].split(':');
    if (kind !== String(KIND.webBookmark)) continue;
    const url = rest.join(':');
    if (!pubkey || !url) continue;
    // NIP-09: ignore forged deletions naming someone else's coordinate.
    if (pubkey.toLowerCase() !== deletion.pubkey.toLowerCase()) continue;
    const key = dedupKey(pubkey, url);
    const existing = byKey.get(key);
    const replaceTime = existing
      ? (existing.bookmark.eventCreatedAt ?? existing.bookmark.savedAt)
      : 0;
    if (existing && deletion.created_at >= replaceTime) {
      byKey.delete(key);
      changed = true;
    }
  }

  if (eTargets.size > 0) {
    for (const [key, entry] of byKey) {
      const replaceTime = entry.bookmark.eventCreatedAt ?? entry.bookmark.savedAt;
      if (entry.bookmark.curator === deletion.pubkey && eTargets.has(entry.bookmark.eventId) && deletion.created_at >= replaceTime) {
        byKey.delete(key);
        changed = true;
      }
    }
  }

  return changed;
}
