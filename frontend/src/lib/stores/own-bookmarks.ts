// Signed-in user's bookmark library, merged from:
//   - Deepmarks API/index for public bookmarks
//   - live relay feed for public kind:39701 bookmarks
//   - local cache + decrypted NIP-51 private set for private bookmarks
//
// Keeping this store shared prevents /app/bookmarks, /app/tags,
// and tag detail pages from each implementing their own slightly different
// "my bookmarks" loader.

import { derived, get, writable, type Readable } from 'svelte/store';
import { api, type PublicBookmark } from '$lib/api/client';
import { cachedBookmarkFeedSnapshot } from '$lib/nostr/feed-cache';
import {
  bookmarkSortTimeMs,
  compareBookmarksNewest,
  type ParsedBookmark
} from '$lib/nostr/bookmarks';
import { canSign, session } from '$lib/stores/session';
import type { ImportedUrlBookmark } from '$lib/nostr/imported-bookmarks';

const PRIVATE_LS_PREFIX = 'deepmarks-private-bookmarks:v3:';
const PUBLIC_LS_PREFIX = 'deepmarks-public-bookmarks:v1:';
const DELETED_LS_PREFIX = 'deepmarks-deleted-bookmarks:v1:';
const OPTIMISTIC_REFRESH_GRACE_MS = 60_000;
const LOCAL_DELETE_TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;

const serverPublicBookmarks = writable<ParsedBookmark[]>([]);

/** Non-null when the last private refresh could not decrypt part of the
 *  set — the UI shows a banner instead of a silently smaller list. */
export const privateDecryptIssue = writable<{
  count: number;
  reason?: import('$lib/nostr/private-bookmarks').DecryptFailureReason;
} | null>(null);
const relayPublicBookmarks = writable<ParsedBookmark[]>([]);
const importedBookmarks = writable<ImportedUrlBookmark[]>([]);
const privateBookmarks = writable<ParsedBookmark[]>([]);
const locallyDeletedUrls = writable<ReadonlySet<string>>(new Set());

let activePubkey: string | null = null;
let relayFeedStop: (() => void) | null = null;
let importedFeedStop: (() => void) | null = null;
let privateLiveSubStop: (() => void) | null = null;
let privateRefreshDebounce: ReturnType<typeof setTimeout> | null = null;
let serverLoadToken = 0;
let privateFetchedPubkey: string | null = null;
let privateLoadingFor: string | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let optimisticPublicPubkey: string | null = null;
let optimisticPublicUntil = 0;
let optimisticPrivatePubkey: string | null = null;
let optimisticPrivateUntil = 0;

function lsLoadPrivate(pubkey: string): ParsedBookmark[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(PRIVATE_LS_PREFIX + pubkey);
    return raw ? (JSON.parse(raw) as ParsedBookmark[]) : [];
  } catch {
    return [];
  }
}

function lsSavePrivate(pubkey: string, list: ParsedBookmark[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PRIVATE_LS_PREFIX + pubkey, JSON.stringify(list));
  } catch {
    // Quota/private mode: the live in-memory list still works.
  }
}

function lsLoadPublic(pubkey: string): ParsedBookmark[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(PUBLIC_LS_PREFIX + pubkey);
    return raw ? (JSON.parse(raw) as ParsedBookmark[]) : [];
  } catch {
    return [];
  }
}

function lsSavePublic(pubkey: string, list: ParsedBookmark[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PUBLIC_LS_PREFIX + pubkey, JSON.stringify(list));
  } catch {
    // Quota/private mode: relay/API loads still work.
  }
}

function lsLoadDeleted(pubkey: string): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(DELETED_LS_PREFIX + pubkey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as Record<string, number>;
    const now = Date.now();
    const urls = Object.entries(parsed)
      .filter(([, deletedAt]) => Number.isFinite(deletedAt) && now - deletedAt < LOCAL_DELETE_TOMBSTONE_MS)
      .map(([url]) => url);
    return new Set(urls);
  } catch {
    return new Set();
  }
}

function lsSaveDeleted(pubkey: string, urls: ReadonlySet<string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const existing = (() => {
      try { return JSON.parse(localStorage.getItem(DELETED_LS_PREFIX + pubkey) ?? '{}') as Record<string, number>; }
      catch { return {}; }
    })();
    const now = Date.now();
    const next: Record<string, number> = {};
    for (const [url, deletedAt] of Object.entries(existing)) {
      if (urls.has(url) && Number.isFinite(deletedAt) && now - deletedAt < LOCAL_DELETE_TOMBSTONE_MS) {
        next[url] = deletedAt;
      }
    }
    for (const url of urls) next[url] = next[url] ?? now;
    if (Object.keys(next).length === 0) {
      localStorage.removeItem(DELETED_LS_PREFIX + pubkey);
    } else {
      localStorage.setItem(DELETED_LS_PREFIX + pubkey, JSON.stringify(next));
    }
  } catch {
    // Quota/private mode: in-memory tombstones still update the UI.
  }
}

function withoutLocallyDeleted<T extends { url: string }>(
  list: T[],
  deleted = get(locallyDeletedUrls),
): T[] {
  if (deleted.size === 0) return list;
  return list.filter((item) => !deleted.has(item.url));
}

function rememberDeletedUrl(pubkey: string | null | undefined, url: string): void {
  locallyDeletedUrls.update((current) => {
    const next = new Set(current);
    next.add(url);
    if (pubkey) lsSaveDeleted(pubkey, next);
    return next;
  });
}

function clearDeletedUrls(pubkey: string | null | undefined, urls: string[]): void {
  if (urls.length === 0) return;
  locallyDeletedUrls.update((current) => {
    if (current.size === 0) return current;
    const next = new Set(current);
    for (const url of urls) next.delete(url);
    if (pubkey) lsSaveDeleted(pubkey, next);
    return next;
  });
}

function publicBookmarkToParsed(bookmark: PublicBookmark): ParsedBookmark {
  return {
    url: bookmark.url,
    title: bookmark.title || bookmark.url,
    description: bookmark.description,
    tags: bookmark.tags,
    publishedAt: bookmark.publishedAt,
    savedAtMs: bookmark.savedAtMs,
    blossomHash: bookmark.blossomHash,
    waybackUrl: bookmark.waybackUrl,
    archivedForever: bookmark.archivedForever,
    savedAt: bookmark.savedAt,
    eventCreatedAt: bookmark.eventCreatedAt,
    curator: bookmark.pubkey,
    eventId: bookmark.id,
  };
}

function setLatestPublic(byUrl: Map<string, ParsedBookmark>, bookmark: ParsedBookmark): void {
  const existing = byUrl.get(bookmark.url);
  if (existing && existing.publishedAt === undefined && bookmark.savedAt < existing.savedAt) {
    byUrl.set(bookmark.url, {
      ...existing,
      publishedAt: bookmark.publishedAt,
      savedAt: bookmark.savedAt,
      savedAtMs: bookmark.savedAtMs,
    });
    return;
  }
  if (!existing || shouldReplaceBookmark(existing, bookmark)) {
    byUrl.set(bookmark.url, mergeBookmarkReplacement(existing, bookmark));
  }
}

function upsertManyLatestByUrl(list: ParsedBookmark[], bookmarks: ParsedBookmark[]): ParsedBookmark[] {
  const byUrl = new Map(list.map((item) => [item.url, item]));
  for (const bookmark of bookmarks) {
    const existing = byUrl.get(bookmark.url);
    if (!existing || shouldReplaceBookmark(existing, bookmark)) {
      byUrl.set(bookmark.url, mergeBookmarkReplacement(existing, bookmark));
    }
  }
  return [...byUrl.values()].sort(compareBookmarksNewest);
}

function shouldReplaceBookmark(existing: ParsedBookmark, incoming: ParsedBookmark): boolean {
  if (
    existing.savedAt === incoming.savedAt &&
    existing.eventId.startsWith('optimistic:') &&
    !incoming.eventId.startsWith('optimistic:')
  ) {
    return true;
  }
  const incomingReplaceTime = incoming.eventCreatedAt ?? incoming.savedAt;
  const existingReplaceTime = existing.eventCreatedAt ?? existing.savedAt;
  if (incomingReplaceTime > existingReplaceTime) return true;
  if (incomingReplaceTime < existingReplaceTime) return false;
  const incomingMs = bookmarkSortTimeMs(incoming);
  const existingMs = bookmarkSortTimeMs(existing);
  if (incomingMs > existingMs) return true;
  if (incomingMs < existingMs) return false;
  if (incoming.savedAt > existing.savedAt) return true;
  if (incoming.savedAt < existing.savedAt) return false;
  // NIP-01: on equal created_at relays retain the LOWEST id — pick the
  // same winner so the UI matches what the relay will serve back.
  return incoming.eventId <= existing.eventId;
}

function mergeBookmarkReplacement(
  existing: ParsedBookmark | undefined,
  incoming: ParsedBookmark,
): ParsedBookmark {
  if (existing && incoming.publishedAt === undefined && existing.savedAt < incoming.savedAt) {
    return {
      ...incoming,
      publishedAt: existing.publishedAt,
      savedAt: existing.savedAt,
      savedAtMs: existing.savedAtMs,
    };
  }
  if (
    existing?.savedAtMs &&
    !incoming.savedAtMs &&
    existing.savedAt === incoming.savedAt
  ) {
    return { ...incoming, savedAtMs: existing.savedAtMs };
  }
  return incoming;
}

function preserveOptimisticPublic(pubkey: string): boolean {
  return optimisticPublicPubkey === pubkey && Date.now() < optimisticPublicUntil;
}

function preserveOptimisticPrivate(pubkey: string): boolean {
  return optimisticPrivatePubkey === pubkey && Date.now() < optimisticPrivateUntil;
}

async function loadServerPublicBookmarks(pubkey: string, token: number): Promise<void> {
  try {
    const res = await api.publicBookmarks(pubkey, 200);
    if (token === serverLoadToken && activePubkey === pubkey) {
      const parsed = withoutLocallyDeleted(res.bookmarks.map(publicBookmarkToParsed));
      // Always MERGE the server response into the local set — never
      // replace. The server's /bookmarks/public cache only knows
      // about events the indexer caught (24h window) and the
      // /admin/relay-stats backfill warmed; any locally-saved
      // bookmark whose publish didn't reach the canonical relay
      // would otherwise vanish once the 60s optimistic-grace window
      // expired, leaving the user staring at the 2-event API cache
      // and wondering where everything went. Merging by URL keeps
      // local saves alive forever; explicit deletes use a separate
      // path (deleteOwnBookmark).
      serverPublicBookmarks.update((current) => {
        const next = withoutLocallyDeleted(upsertManyLatestByUrl(current, parsed));
        lsSavePublic(pubkey, next);
        return next;
      });
    }
  } catch {
    // Relay + local browser caches still load.
  }
}

async function refreshPrivate(pubkey: string): Promise<void> {
  if (privateFetchedPubkey === pubkey || privateLoadingFor === pubkey) return;
  privateLoadingFor = pubkey;
  try {
    const [{ fetchOwnPrivateSet, parsePrivateEntry }, { getRelayList }] = await Promise.all([
      import('$lib/nostr/private-bookmarks'),
      import('$lib/nostr/relay-list'),
    ]);
    // Pull NIP-65 advertised relays as extras so we read from every
    // place the user's chunks could live, not just Deepmarks settings.
    const relayListStore = getRelayList(pubkey);
    const relayListSnapshot = relayListStore ? get(relayListStore as Readable<unknown>) : null;
    const extraRelays = Array.isArray((relayListSnapshot as { relays?: { url: string }[] } | null)?.relays)
      ? ((relayListSnapshot as { relays: { url: string }[] }).relays.map((r) => r.url))
      : [];
    const set = await fetchOwnPrivateSet(pubkey, extraRelays);
    if (activePubkey === pubkey) {
      privateDecryptIssue.set(
        set.decryptFailures && set.decryptFailures > 0
          ? { count: set.decryptFailures, reason: set.decryptFailureReason }
          : null,
      );
    }
    const parsed: ParsedBookmark[] = [];
    const setCreatedAt = set.createdAt ?? Math.floor(Date.now() / 1000);
    for (const [index, entry] of set.entries.entries()) {
      // parsePrivateEntry uses this ONLY when a legacy inner entry has
      // no published_at. Derive it from set order instead of local cache
      // so normal and incognito windows sort those old entries the same.
      const fallback = legacyPrivateFallbackSavedAt(setCreatedAt, set.entries.length, index);
      const p = parsePrivateEntry(entry, pubkey, fallback, '');
      if (p) parsed.push(p);
    }
    const deletedUrls = set.deletedUrls ?? {};
    if (activePubkey === pubkey && (parsed.length > 0 || Object.keys(deletedUrls).length > 0)) {
      // Always merge — same reason as loadServerPublicBookmarks.
      // Relay flakiness means a freshly-saved private bookmark may
      // not have reached the canonical relay yet; replacing local
      // state with the relay's chunk-decrypted set would lose it.
      // Exception: entries covered by a NEWER relay tombstone were
      // deleted on another device — keeping them here both shows a
      // ghost bookmark and re-feeds the localStorage cache that the
      // next set rewrite unions in, resurrecting the delete.
      const coveredByTombstone = (bookmark: ParsedBookmark): boolean => {
        const deletedAt = deletedUrls[bookmark.url];
        return deletedAt !== undefined && deletedAt >= (bookmark.savedAt ?? 0);
      };
      privateBookmarks.update((current) => {
        const currentByUrl = new Map(current.map((bookmark) => [bookmark.url, bookmark]));
        const mergedParsed = preserveOptimisticPrivate(pubkey)
          ? parsed.map((bookmark) => {
              const existing = currentByUrl.get(bookmark.url);
              return existing && shouldReplaceBookmark(bookmark, existing) ? existing : bookmark;
            })
          : parsed;
        const parsedUrls = new Set(mergedParsed.map((bookmark) => bookmark.url));
        const next = withoutLocallyDeleted(
          [
            ...current.filter((bookmark) => !parsedUrls.has(bookmark.url) && !coveredByTombstone(bookmark)),
            ...mergedParsed,
          ].sort(compareBookmarksNewest),
        );
        lsSavePrivate(pubkey, next);
        return next;
      });
    }
    if (activePubkey === pubkey) {
      privateFetchedPubkey = pubkey;
    }
  } catch (err) {
    // Keep the local cache visible; we'll retry on the next signer
    // change. Log so we can spot decryption / network issues.
    console.warn('Deepmarks refreshPrivate failed:', err);
  } finally {
    if (privateLoadingFor === pubkey) privateLoadingFor = null;
  }
}

function legacyPrivateFallbackSavedAt(setCreatedAt: number, totalEntries: number, index: number): number {
  // Old encrypted-set entries predate per-entry published_at. The set array
  // was append-ordered, so later entries should sort newer. Keep every value
  // below the set event's created_at to avoid colliding with current saves.
  return Math.max(1, setCreatedAt - Math.max(1, totalEntries - index));
}

session.subscribe(($session) => {
  const pubkey = $session.pubkey;
  if (pubkey === activePubkey) return;

  activePubkey = pubkey;
  serverLoadToken += 1;
  privateFetchedPubkey = null;
  privateLoadingFor = null;

  clearStartupTimer();
  relayFeedStop?.();
  importedFeedStop?.();
  privateLiveSubStop?.();
  if (privateRefreshDebounce) clearTimeout(privateRefreshDebounce);
  privateRefreshDebounce = null;
  relayFeedStop = null;
  importedFeedStop = null;
  privateLiveSubStop = null;
  relayPublicBookmarks.set(pubkey ? cachedBookmarkFeedSnapshot({ authors: [pubkey], limit: 200 }) : []);
  importedBookmarks.set([]);
  const deleted = pubkey ? lsLoadDeleted(pubkey) : new Set<string>();
  locallyDeletedUrls.set(deleted);
  serverPublicBookmarks.set(pubkey ? withoutLocallyDeleted(lsLoadPublic(pubkey), deleted) : []);
  privateBookmarks.set(pubkey ? withoutLocallyDeleted(lsLoadPrivate(pubkey), deleted) : []);

  if (!pubkey) return;

  startNetworkLoadsSoon(pubkey, serverLoadToken);
});

canSign.subscribe((ok) => {
  const pubkey = get(session).pubkey;
  if (!ok || !pubkey) return;
  void refreshPrivate(pubkey);
  // The NIP-51 import feed may have absorbed encrypted third-party lists
  // before the signer attached; restart it so private imported bookmarks
  // decrypt and appear now.
  restartImportedFeedForSigner(pubkey);
  // Signer just became available — kick the durable-publish drain so
  // any saves we queued while signer-locked actually go out now.
  void import('$lib/nostr/pending-publish').then(({ drainPendingPublishes }) => (
    drainPendingPublishes(pubkey)
  )).catch(() => { /* tolerable */ });
  // Same trick for the iOS Share Extension drain: a passkey-locked or
  // bunker-pending session won't have a signer until the user unlocks,
  // and the on-foreground drain may have bailed before then. Run again
  // now that we can actually sign.
  void import('$lib/mobile/share-drain').then(({ drainPendingShares }) => (
    drainPendingShares()
  )).catch(() => { /* tolerable */ });
  // Silent migration helper: if the local cache holds way more
  // bookmarks than the canonical relay has, quietly enqueue the
  // missing ones into the durable-publish queue. Fires at most
  // once per pubkey per 24h. No UI; the manual button in
  // /app/settings is the explicit version of this for power users.
  void import('$lib/nostr/auto-republish').then(({ maybeAutoRepublish }) => (
    maybeAutoRepublish(pubkey)
  )).catch(() => { /* tolerable — retries on next canSign tick */ });
});

function clearStartupTimer(): void {
  if (!startupTimer) return;
  clearTimeout(startupTimer);
  startupTimer = null;
}

/** Re-subscribe the third-party NIP-51 import once a signer becomes
 *  available. The feed created during startNetworkLoads may have
 *  absorbed encrypted 10003/30003 lists before the signer attached
 *  (passkey unlock, NIP-46 bunker connect). Those private tags only
 *  decrypt with a signer, and the open subscription won't re-deliver
 *  events it already saw, so restart it to replay the cached lists
 *  through the decrypt path. tryDecryptNip51PrivateTags caches by
 *  event id+content, so this shares decryptions with the note-ref feed
 *  rather than double-prompting the signer. */
function restartImportedFeedForSigner(pubkey: string): void {
  if (activePubkey !== pubkey) return;
  void import('$lib/nostr/imported-bookmarks').then(({ createImportedBookmarksFeed }) => {
    if (activePubkey !== pubkey || !get(canSign)) return;
    importedFeedStop?.();
    importedFeedStop = createImportedBookmarksFeed({ authors: [pubkey], limit: 500, decryptPrivate: true }).subscribe((list) => {
      importedBookmarks.set(withoutLocallyDeleted(list));
    });
  }).catch(() => {
    // Public API + local caches still render; we retry on the next canSign tick.
  });
}

function startNetworkLoadsSoon(pubkey: string, token: number): void {
  clearStartupTimer();
  startupTimer = setTimeout(() => {
    startupTimer = null;
    void startNetworkLoads(pubkey, token);
  }, 0);
}

async function startNetworkLoads(pubkey: string, token: number): Promise<void> {
  if (activePubkey !== pubkey || token !== serverLoadToken) return;
  try {
    const [{ createBookmarkFeed }, { createImportedBookmarksFeed }] = await Promise.all([
      import('$lib/nostr/feed'),
      import('$lib/nostr/imported-bookmarks'),
    ]);
    if (activePubkey !== pubkey || token !== serverLoadToken) return;
    relayFeedStop = createBookmarkFeed({ authors: [pubkey], limit: 200 }).subscribe((list) => {
      relayPublicBookmarks.set(withoutLocallyDeleted(list));
    });
    // decryptPrivate so a fully-private NIP-51 list (Amethyst/Primal/
    // Damus "private bookmarks" — all refs encrypted in `content`, zero
    // public tags) actually shows up. Without it the imported list is
    // mirrored onto our relay but renders empty. Gate on the current
    // signer; restartImportedFeedForSigner re-runs this once a
    // passkey/bunker signer attaches after the initial load.
    importedFeedStop?.();
    importedFeedStop = createImportedBookmarksFeed({ authors: [pubkey], limit: 500, decryptPrivate: get(canSign) }).subscribe((list) => {
      importedBookmarks.set(withoutLocallyDeleted(list));
    });
    // Live re-sync for private-set chunks. When the user saves a
    // private bookmark on Device A, all 25 chunks land on
    // relay.deepmarks.org; this subscription notices them on Device
    // B and triggers a debounced refreshPrivate so the new entry
    // shows up without the user pulling-to-refresh. createBookmark
    // Feed already covers kind:39701 push, createImportedBookmarks
    // Feed covers kind:10003 + non-Deepmarks kind:30003; this
    // closes the last gap.
    void startPrivateLiveSub(pubkey, token);
  } catch {
    // Public API + local caches still render the user's bookmarks.
  }
  void loadServerPublicBookmarks(pubkey, token);
  if (get(canSign)) void refreshPrivate(pubkey);
}

async function startPrivateLiveSub(pubkey: string, token: number): Promise<void> {
  if (activePubkey !== pubkey || token !== serverLoadToken) return;
  const [{ getNdk }, { KIND }, { NDKSubscriptionCacheUsage }] = await Promise.all([
    import('$lib/nostr/ndk'),
    import('$lib/nostr/kinds'),
    import('@nostr-dev-kit/ndk'),
  ]);
  if (activePubkey !== pubkey || token !== serverLoadToken) return;
  const ndk = getNdk();
  // Subscribe from now-forward; we don't need historical (refreshPrivate
  // already does the bulk load). closeOnEose:false keeps it open for
  // live push. ONLY_RELAY so the Dexie cache isn't replayed — we want
  // genuine new events.
  const sub = ndk.subscribe(
    {
      kinds: [KIND.privateBookmarkSet as never],
      authors: [pubkey],
      since: Math.floor(Date.now() / 1000),
    },
    { closeOnEose: false, cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY },
  );
  sub.on('event', (event) => {
    if (activePubkey !== pubkey) return;
    const d = event.tags.find((t: string[]) => t[0] === 'd')?.[1];
    if (!d) return;
    const isPrivateChunk =
      d === 'deepmarks-private' ||
      /^deepmarks-private-\d+$/.test(d) ||
      d.startsWith('deepmarks-private-item:') ||
      d === 'deepmarks-archive-keys';
    if (!isPrivateChunk) return;
    schedulePrivateRefresh(pubkey);
  });
  privateLiveSubStop = () => sub.stop();
}

/** Debounce a re-fetch of the private set. A single user save publishes
 *  the entire chunked set in parallel (25+ events arriving within a few
 *  hundred ms), so we want to wait for the burst to settle before doing
 *  the decryption pass. */
function schedulePrivateRefresh(pubkey: string): void {
  if (privateRefreshDebounce) clearTimeout(privateRefreshDebounce);
  privateRefreshDebounce = setTimeout(() => {
    privateRefreshDebounce = null;
    if (activePubkey !== pubkey || !get(canSign)) return;
    // Bypass the "already fetched" latch — we know there's been a
    // change on the relay, that's the whole reason we're here.
    privateFetchedPubkey = null;
    privateLoadingFor = null;
    void refreshPrivate(pubkey);
  }, 250);
}

export const ownBookmarks: Readable<ParsedBookmark[]> = derived(
  [serverPublicBookmarks, relayPublicBookmarks, importedBookmarks, privateBookmarks, locallyDeletedUrls],
  ([$serverPub, $relayPub, $imported, $priv, $deleted]) => {
    const byUrl = new Map<string, ParsedBookmark>();
    for (const b of $serverPub) setLatestPublic(byUrl, b);
    for (const b of $relayPub) setLatestPublic(byUrl, b);
    for (const b of $imported) {
      if (!byUrl.has(b.url)) byUrl.set(b.url, b);
    }
    for (const b of $priv) byUrl.set(b.url, b);
    for (const url of $deleted) byUrl.delete(url);
    return [...byUrl.values()].sort(compareBookmarksNewest);
  },
);

/**
 * Force-refresh the signed-in user's bookmarks from the server and
 * (when a signer is available) the encrypted private set. Used by the
 * native app's foreground listener so saves made in another client
 * (extension, web) show up the moment the user opens the app, even if
 * the relay subscription was paused while the app was backgrounded.
 *
 * Also drains the durable-publish queue so any save whose initial
 * publish didn't reach a relay gets retried in the background.
 */
export function refreshOwnBookmarks(): void {
  const pubkey = activePubkey;
  if (!pubkey) return;
  // Reset the private-fetch latch so refreshPrivate actually re-runs
  // instead of bailing on its "already loaded" check.
  privateFetchedPubkey = null;
  privateLoadingFor = null;
  serverLoadToken += 1;
  void loadServerPublicBookmarks(pubkey, serverLoadToken);
  if (get(canSign)) void refreshPrivate(pubkey);
  // Fire-and-forget — drain failures shouldn't block UI.
  void import('$lib/nostr/pending-publish').then(({ drainPendingPublishes }) => (
    drainPendingPublishes(pubkey)
  )).catch(() => { /* tolerable */ });
}

export function rememberOwnBookmark(bookmark: ParsedBookmark, isPublic: boolean): void {
  rememberOwnBookmarks([bookmark], isPublic);
}

export function rememberOwnBookmarkWithRollback(
  bookmark: ParsedBookmark,
  isPublic: boolean,
): () => void {
  const pubkey = get(session).pubkey;
  const beforeDeleted = get(locallyDeletedUrls);
  if (isPublic) {
    const beforePublic = get(serverPublicBookmarks);
    rememberOwnBookmark(bookmark, true);
    return () => {
      locallyDeletedUrls.set(beforeDeleted);
      serverPublicBookmarks.set(beforePublic);
      if (pubkey) {
        lsSaveDeleted(pubkey, beforeDeleted);
        lsSavePublic(pubkey, beforePublic);
      }
    };
  }

  const beforePrivate = get(privateBookmarks);
  rememberOwnBookmark(bookmark, false);
  return () => {
    locallyDeletedUrls.set(beforeDeleted);
    privateBookmarks.set(beforePrivate);
    if (pubkey) {
      lsSaveDeleted(pubkey, beforeDeleted);
      lsSavePrivate(pubkey, beforePrivate);
    }
  };
}

export function forgetOwnBookmark(url: string): void {
  if (!url) return;
  const pubkey = get(session).pubkey;
  rememberDeletedUrl(pubkey, url);
  serverPublicBookmarks.update((list) => {
    const next = list.filter((bookmark) => bookmark.url !== url);
    if (pubkey) lsSavePublic(pubkey, next);
    return next;
  });
  relayPublicBookmarks.update((list) => list.filter((bookmark) => bookmark.url !== url));
  importedBookmarks.update((list) => list.filter((bookmark) => bookmark.url !== url));
  privateBookmarks.update((list) => {
    const next = list.filter((bookmark) => bookmark.url !== url);
    if (pubkey) lsSavePrivate(pubkey, next);
    return next;
  });
}

/**
 * Update local cache with newly-saved bookmarks. Used to be paired
 * with a `bumpToTop` helper that forced the new entry's savedAt
 * above every existing entry. That bump was a workaround for
 * parsePrivateEntry stamping every chunk-decrypted entry with
 * "refresh time" as savedAt, which collapsed all private entries to
 * the same timestamp. Now that saveBookmark writes a real
 * `published_at` into the inner tags and parsePrivateEntry reads it
 * back as savedAt, no local bumping is needed — and the bump was
 * the actual cause of cross-device sort divergence (each device
 * bumped its own saves, the bumped value never propagated to
 * other devices reading the same chunks).
 */
export function rememberOwnBookmarks(bookmarks: ParsedBookmark[], isPublic: boolean): void {
  if (bookmarks.length === 0) return;
  const pubkey = get(session).pubkey;
  clearDeletedUrls(pubkey, bookmarks.map((bookmark) => bookmark.url));
  if (isPublic) {
    if (pubkey) {
      optimisticPublicPubkey = pubkey;
      optimisticPublicUntil = Date.now() + OPTIMISTIC_REFRESH_GRACE_MS;
    }
    serverPublicBookmarks.update((list) => {
      const next = upsertManyLatestByUrl(list, bookmarks);
      if (pubkey) lsSavePublic(pubkey, next);
      return next;
    });
    return;
  }
  if (pubkey) {
    optimisticPrivatePubkey = pubkey;
    optimisticPrivateUntil = Date.now() + OPTIMISTIC_REFRESH_GRACE_MS;
  }
  privateBookmarks.update((list) => {
    const next = upsertManyLatestByUrl(list, bookmarks);
    if (pubkey) lsSavePrivate(pubkey, next);
    return next;
  });
}
