// Signed-in user's bookmark library, merged from:
//   - Deepmarks API/index for public bookmarks
//   - live relay feed for public kind:39701 bookmarks
//   - local cache + decrypted NIP-51 private set for private bookmarks
//
// Keeping this store shared prevents /app/bookmarks, /app/tags?scope=mine,
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
const OPTIMISTIC_REFRESH_GRACE_MS = 60_000;

const serverPublicBookmarks = writable<ParsedBookmark[]>([]);
const relayPublicBookmarks = writable<ParsedBookmark[]>([]);
const importedBookmarks = writable<ImportedUrlBookmark[]>([]);
const privateBookmarks = writable<ParsedBookmark[]>([]);

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

function publicBookmarkToParsed(bookmark: PublicBookmark): ParsedBookmark {
  return {
    url: bookmark.url,
    title: bookmark.title || bookmark.url,
    description: bookmark.description,
    tags: bookmark.tags,
    publishedAt: bookmark.publishedAt,
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
  return incoming.eventId >= existing.eventId;
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
      const parsed = res.bookmarks.map(publicBookmarkToParsed);
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
        const next = upsertManyLatestByUrl(current, parsed);
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
    const parsed: ParsedBookmark[] = [];
    const now = Math.floor(Date.now() / 1000);
    // Index the existing local cache by URL so legacy entries (no
    // `published_at` inner tag) preserve their previously-stamped
    // savedAt across refreshes. Without this every refresh advances
    // every legacy entry's timestamp to NOW, which is what caused
    // "almost all of my bookmarks are listed as 1 min ago" after
    // the relay started serving freshly-rewritten chunks.
    const existingByUrl = new Map<string, number>();
    for (const b of get(privateBookmarks)) existingByUrl.set(b.url, b.savedAt);
    for (const entry of set.entries) {
      // parsePrivateEntry uses its savedAt arg ONLY as a fallback
      // when the inner `published_at` tag is missing. Pass the
      // existing local savedAt when we already have one — that way
      // legacy entries get a one-time NOW stamp on FIRST sight and
      // stay there forever after.
      const url = entry.find((t) => t[0] === 'd')?.[1];
      const fallback = url ? (existingByUrl.get(url) ?? now) : now;
      const p = parsePrivateEntry(entry, pubkey, fallback, '');
      if (p) parsed.push(p);
    }
    if (activePubkey === pubkey && parsed.length > 0) {
      // Always merge — same reason as loadServerPublicBookmarks.
      // Relay flakiness means a freshly-saved private bookmark may
      // not have reached the canonical relay yet; replacing local
      // state with the relay's chunk-decrypted set would lose it.
      // Private deletes use removeFromPrivateSet which already
      // updates the local store explicitly, so always-merge here
      // doesn't strand deleted entries.
      privateBookmarks.update((current) => {
        const beforeCount = current.length;
        const next = upsertManyLatestByUrl(current, parsed);
        const dropped = current.filter((c) => !next.some((n) => n.url === c.url));
        // Diagnostic: should never be a non-empty drop list since
        // upsertManyLatestByUrl is supposed to be non-destructive
        // (only replaces, never removes). If we see any drops in
        // production logs, that's the bug pattern behind 'I saved
        // it and it disappeared after the auto-refresh.'
        console.log('[deepmarks private-refresh]', {
          beforeCount,
          relayCount: parsed.length,
          afterCount: next.length,
          droppedCount: dropped.length,
          droppedUrls: dropped.slice(0, 5).map((b) => b.url),
        });
        lsSavePrivate(pubkey, next);
        return next;
      });
    } else if (activePubkey === pubkey) {
      // parsed.length === 0 path. We deliberately skip the merge —
      // an empty relay set should not wipe local. Log for parity.
      console.log('[deepmarks private-refresh] relay returned 0 entries — leaving local untouched');
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
  serverPublicBookmarks.set(pubkey ? lsLoadPublic(pubkey) : []);
  privateBookmarks.set(pubkey ? lsLoadPrivate(pubkey) : []);

  if (!pubkey) return;

  startNetworkLoadsSoon(pubkey, serverLoadToken);
});

canSign.subscribe((ok) => {
  const pubkey = get(session).pubkey;
  if (!ok || !pubkey) return;
  void refreshPrivate(pubkey);
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
      relayPublicBookmarks.set(list);
    });
    importedFeedStop = createImportedBookmarksFeed({ authors: [pubkey], limit: 500 }).subscribe((list) => {
      importedBookmarks.set(list);
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
  [serverPublicBookmarks, relayPublicBookmarks, importedBookmarks, privateBookmarks],
  ([$serverPub, $relayPub, $imported, $priv]) => {
    const byUrl = new Map<string, ParsedBookmark>();
    for (const b of $serverPub) setLatestPublic(byUrl, b);
    for (const b of $relayPub) setLatestPublic(byUrl, b);
    for (const b of $imported) {
      if (!byUrl.has(b.url)) byUrl.set(b.url, b);
    }
    for (const b of $priv) byUrl.set(b.url, b);
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
