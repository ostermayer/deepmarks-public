// Reactive store of the signed-in user's archive records, keyed by URL.
//
// Populated from GET /account/archives (NIP-98 auth). Used by row
// components to enhance the 'archived' indicator: hover shows the
// thumbnail screenshot, click opens the snapshot on Blossom.
//
// Two-tier cache (same pattern as the bookmark feeds):
//   1. localStorage prime — synchronous; the hover-thumbnail and
//      click-to-open work on first paint without waiting for the
//      NIP-98 round-trip.
//   2. Live fetch — runs once `canSign` flips true; updates the
//      store + cache when fresh data arrives.

import { writable, derived, type Readable } from 'svelte/store';
import { api, type ArchiveRecord } from '$lib/api/client';
import { session, canSign } from '$lib/stores/session';
import { createCachedKv } from '$lib/util/cached-kv';

// v2 = migrated from inline lsLoad/lsSave to createCachedKv (envelope
// shape changed; v1 entries are treated as misses and re-fetched).
const archivesCache = createCachedKv<ArchiveRecord[]>({
  prefix: 'deepmarks-my-archives',
  version: 'v2',
});

const recordsByUrl = writable<Map<string, ArchiveRecord>>(new Map());
let lastFetchedPubkey: string | null = null;
let lastFetchedAt = 0;

/** Public read-only store: lookup by URL. Returns the user's archive
 *  record for that URL when the user has archived it, undefined
 *  otherwise. Used by BookmarkCard to enhance the archived indicator. */
export const myArchives: Readable<Map<string, ArchiveRecord>> = {
  subscribe: recordsByUrl.subscribe,
};

/** Convenience: check if a URL has been archived without subscribing. */
export const hasArchive: Readable<(url: string) => boolean> = derived(
  recordsByUrl,
  ($m) => (url: string) => $m.has(url),
);

/** Optimistic/local insert after an archive completes in this browser.
 *  The backend is still the source of truth; this keeps the current
 *  page from looking stale while relay/app caches catch up. */
export function rememberArchiveRecord(pubkey: string | null | undefined, rec: ArchiveRecord): void {
  recordsByUrl.update((current) => {
    const next = new Map(current);
    if (rec.url) next.set(rec.url, rec);
    return next;
  });
  if (!pubkey) return;
  lastFetchedPubkey = pubkey;
  lastFetchedAt = Date.now();
  const cached = archivesCache.load(pubkey) ?? [];
  const deduped = cached.filter((r) => r.blobHash !== rec.blobHash && r.url !== rec.url);
  archivesCache.save(pubkey, [rec, ...deduped]);
}

/** Replace the local archive index with a fresh server list. This keeps
 * pages that only subscribe to myArchives in sync when another workflow
 * already paid the cost of calling /account/archives. */
export function replaceMyArchiveRecords(pubkey: string | null | undefined, records: ArchiveRecord[]): void {
  const map = new Map<string, ArchiveRecord>();
  for (const rec of records) if (rec.url) map.set(rec.url, rec);
  recordsByUrl.set(map);
  if (!pubkey) return;
  lastFetchedPubkey = pubkey;
  lastFetchedAt = Date.now();
  archivesCache.save(pubkey, records);
}

/** Subscribe to session pubkey + canSign. Synchronous prime first;
 *  live fetch once the signer is attached. Re-runs whenever the
 *  pubkey changes. Idempotent — won't refetch within 30s of the
 *  last successful load to avoid hammering the endpoint as the user
 *  navigates between /app surfaces. */
export function startMyArchivesLoader(): () => void {
  const stop1 = session.subscribe((s) => {
    if (s.pubkey && s.pubkey !== lastFetchedPubkey) {
      // Sync prime as soon as we know the pubkey.
      const cached = archivesCache.load(s.pubkey) ?? [];
      const map = new Map<string, ArchiveRecord>();
      for (const r of cached) if (r.url) map.set(r.url, r);
      recordsByUrl.set(map);
    } else if (!s.pubkey) {
      recordsByUrl.set(new Map());
      lastFetchedPubkey = null;
      lastFetchedAt = 0;
    }
  });
  const stop2 = canSign.subscribe((cs) => {
    if (!cs) return;
    let pubkey: string | null = null;
    session.subscribe((s) => { pubkey = s.pubkey; })();
    if (!pubkey) return;
    const now = Date.now();
    if (pubkey === lastFetchedPubkey && now - lastFetchedAt < 30_000) return;
    lastFetchedPubkey = pubkey;
    lastFetchedAt = now;
    void api.archives
      .listAll()
      .then((records) => {
        replaceMyArchiveRecords(pubkey, records);
      })
      .catch(() => { /* tolerable; cache stays */ });
  });
  return () => { stop1(); stop2(); };
}
