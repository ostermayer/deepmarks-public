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
import type { ParsedBookmark } from '$lib/nostr/bookmarks';
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
    curator: bookmark.pubkey,
    eventId: bookmark.id,
  };
}

function setLatestPublic(byUrl: Map<string, ParsedBookmark>, bookmark: ParsedBookmark): void {
  const existing = byUrl.get(bookmark.url);
  if (!existing || bookmark.savedAt > existing.savedAt || (
    bookmark.savedAt === existing.savedAt && bookmark.eventId > existing.eventId
  )) {
    byUrl.set(bookmark.url, bookmark);
  }
}

function upsertManyLatestByUrl(list: ParsedBookmark[], bookmarks: ParsedBookmark[]): ParsedBookmark[] {
  const byUrl = new Map(list.map((item) => [item.url, item]));
  for (const bookmark of bookmarks) {
    const existing = byUrl.get(bookmark.url);
    if (!existing || bookmark.savedAt >= existing.savedAt) byUrl.set(bookmark.url, bookmark);
  }
  return [...byUrl.values()].sort((a, b) => b.savedAt - a.savedAt);
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
      serverPublicBookmarks.update((current) => {
        const next = preserveOptimisticPublic(pubkey)
          ? upsertManyLatestByUrl(current, parsed)
          : parsed;
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
    const savedAt = Math.floor(Date.now() / 1000);
    for (const entry of set.entries) {
      const p = parsePrivateEntry(entry, pubkey, savedAt, '');
      if (p) parsed.push(p);
    }
    if (activePubkey === pubkey && parsed.length > 0) {
      privateBookmarks.update((current) => {
        const next = preserveOptimisticPrivate(pubkey)
          ? upsertManyLatestByUrl(current, parsed)
          : parsed;
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
  relayFeedStop = null;
  importedFeedStop = null;
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
  } catch {
    // Public API + local caches still render the user's bookmarks.
  }
  void loadServerPublicBookmarks(pubkey, token);
  if (get(canSign)) void refreshPrivate(pubkey);
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
    return [...byUrl.values()].sort((a, b) => b.savedAt - a.savedAt);
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
