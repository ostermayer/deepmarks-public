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
import { auditArchiveKeyHealth } from '$lib/archives/key-health';

// v2 = migrated from inline lsLoad/lsSave to createCachedKv (envelope
// shape changed; v1 entries are treated as misses and re-fetched).
const archivesCache = createCachedKv<ArchiveRecord[]>({
  prefix: 'deepmarks-my-archives',
  version: 'v2',
});

const recordsByUrl = writable<Map<string, ArchiveRecord>>(new Map());
const allRecords = writable<ArchiveRecord[]>([]);
let lastFetchedPubkey: string | null = null;
let lastFetchedAt = 0;
let archiveFetchSeq = 0;

/** Public read-only store: lookup by URL. Returns the user's archive
 *  record for that URL when the user has archived it, undefined
 *  otherwise. Used by BookmarkCard to enhance the archived indicator. */
export const myArchives: Readable<Map<string, ArchiveRecord>> = {
  subscribe: recordsByUrl.subscribe,
};

export const myArchiveRecords: Readable<ArchiveRecord[]> = {
  subscribe: allRecords.subscribe,
};

/** Secondary index for media add-on archives. Their stored `url` is the
 *  canonicalized form the worker downloaded (e.g. a YouTube watch URL
 *  normalized to the 11-char id), so it does NOT match the original
 *  bookmark URL — which still carries `m.` / `app=desktop` / `t=` query
 *  junk — by exact string. Keyed by `videoContentKey` (e.g. `yt:<id>`)
 *  and `yt:<videoId>` so a bookmark row can resolve its own media
 *  archive from the video id even when the URLs differ. */
export const myArchivesByVideoKey: Readable<Map<string, ArchiveRecord>> = derived(
  allRecords,
  ($records) => {
    const map = new Map<string, ArchiveRecord>();
    for (const rec of $records) {
      if (rec.videoContentKey) upsertArchiveByKey(map, rec.videoContentKey.toLowerCase(), rec);
      if (rec.videoId) upsertArchiveByKey(map, `yt:${rec.videoId.toLowerCase()}`, rec);
      const urlVideoKey = videoContentKeyFromUrl(rec.url);
      if (urlVideoKey) upsertArchiveByKey(map, urlVideoKey, rec);
    }
    return map;
  },
);

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
    upsertArchiveRecord(next, rec);
    return next;
  });
  allRecords.update((current) => [rec, ...current.filter((r) => r.blobHash !== rec.blobHash)]);
  if (!pubkey) return;
  lastFetchedPubkey = pubkey;
  lastFetchedAt = Date.now();
  const cached = archivesCache.load(pubkey) ?? [];
  const deduped = cached.filter((r) => r.blobHash !== rec.blobHash && r.jobId !== rec.jobId);
  archivesCache.save(pubkey, [rec, ...deduped]);
}

/** Replace the local archive index with a fresh server list. This keeps
 * pages that only subscribe to myArchives in sync when another workflow
 * already paid the cost of calling /account/archives. */
export function replaceMyArchiveRecords(pubkey: string | null | undefined, records: ArchiveRecord[]): void {
  const map = archiveRecordsByLookupKey(records);
  recordsByUrl.set(map);
  allRecords.set(records);
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
      const map = archiveRecordsByLookupKey(cached);
      recordsByUrl.set(map);
      allRecords.set(cached);
    } else if (!s.pubkey) {
      recordsByUrl.set(new Map());
      allRecords.set([]);
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
    const seq = ++archiveFetchSeq;
    void refreshMyArchiveRecords(pubkey, seq);
  });
  return () => { stop1(); stop2(); };
}

async function refreshMyArchiveRecords(pubkey: string, seq: number): Promise<void> {
  const records: ArchiveRecord[] = [];
  const limit = 1000;
  try {
    for (let offset = 0; offset <= 50_000; offset += limit) {
      const page = await api.archives.page({ limit, offset });
      if (seq !== archiveFetchSeq || pubkey !== lastFetchedPubkey) return;
      records.push(...page.archives);
      mergeMyArchiveRecords(pubkey, page.archives);
      if (page.count === 0 || records.length >= page.total) break;
    }
    // Promote pending keys and record missing-key health, but keep
    // server-known archive rows visible. Missing keys should trigger
    // repair/open handling, not erase the archive indicator.
    await auditArchiveKeyHealth(records, pubkey).catch(() => undefined);
    if (seq !== archiveFetchSeq || pubkey !== lastFetchedPubkey) return;
    replaceMyArchiveRecords(pubkey, records);
  } catch {
    // Tolerable; any pages already merged stay visible and the cache
    // remains at the last complete successful load.
  }
}

function mergeMyArchiveRecords(pubkey: string | null | undefined, records: ArchiveRecord[]): void {
  if (records.length === 0) return;
  recordsByUrl.update((current) => {
    const next = new Map(current);
    for (const rec of records) upsertArchiveRecord(next, rec);
    return next;
  });
  allRecords.update((current) => mergeArchiveRecordList(current, records));
  if (!pubkey) return;
  lastFetchedPubkey = pubkey;
  lastFetchedAt = Date.now();
}

export function isMediaArchiveRecord(record: ArchiveRecord | undefined): boolean {
  if (!record) return false;
  const kind = (record.kind ?? '').toLowerCase();
  const contentType = (record.contentType ?? '').toLowerCase();
  return kind === 'media' ||
    kind === 'video' ||
    kind === 'youtube' ||
    !!record.videoContentKey ||
    !!record.videoId ||
    contentType.startsWith('video/') ||
    contentType.startsWith('audio/') ||
    contentType.startsWith('image/') ||
    (record.files ?? []).some((file) => file.role === 'media');
}

export function chooseArchiveRecord(
  existing: ArchiveRecord | undefined,
  incoming: ArchiveRecord,
): ArchiveRecord {
  if (!existing) return incoming;
  const existingMedia = isMediaArchiveRecord(existing);
  const incomingMedia = isMediaArchiveRecord(incoming);
  if (existingMedia !== incomingMedia) return incomingMedia ? incoming : existing;
  return compareArchiveRecordsNewest(incoming, existing) < 0 ? incoming : existing;
}

function upsertArchiveByKey(
  map: Map<string, ArchiveRecord>,
  key: string | undefined,
  rec: ArchiveRecord,
): void {
  if (!key) return;
  map.set(key, chooseArchiveRecord(map.get(key), rec));
}

function upsertArchiveRecord(
  map: Map<string, ArchiveRecord>,
  rec: ArchiveRecord,
): void {
  for (const key of archiveLookupKeys(rec.url)) upsertArchiveByKey(map, key, rec);
}

function archiveRecordsByLookupKey(records: ArchiveRecord[]): Map<string, ArchiveRecord> {
  const map = new Map<string, ArchiveRecord>();
  for (const rec of records) upsertArchiveRecord(map, rec);
  return map;
}

function mergeArchiveRecordList(current: ArchiveRecord[], incoming: ArchiveRecord[]): ArchiveRecord[] {
  const byId = new Map<string, ArchiveRecord>();
  for (const rec of current) byId.set(archiveRecordId(rec), rec);
  for (const rec of incoming) byId.set(archiveRecordId(rec), rec);
  return [...byId.values()].sort(compareArchiveRecordsNewest);
}

function archiveRecordId(rec: ArchiveRecord): string {
  return rec.blobHash || rec.jobId;
}

export function archiveLookupKeys(rawUrl: string | undefined): string[] {
  if (!rawUrl) return [];
  const keys = new Set<string>([rawUrl]);
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    const normalized = url.toString();
    keys.add(normalized);
    if (url.pathname === '/') {
      keys.add(`${url.origin}${url.search}`);
    } else if (url.pathname.endsWith('/')) {
      const withoutSlash = new URL(normalized);
      withoutSlash.pathname = withoutSlash.pathname.replace(/\/+$/, '');
      keys.add(withoutSlash.toString());
    } else {
      const withSlash = new URL(normalized);
      withSlash.pathname = `${withSlash.pathname}/`;
      keys.add(withSlash.toString());
    }
  } catch {
    // Keep the raw key for non-URL legacy records.
  }
  return [...keys].filter(Boolean);
}

function videoContentKeyFromUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    let id: string | null = null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (url.pathname === '/watch') id = url.searchParams.get('v');
      else {
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') id = parts[1] ?? null;
      }
    } else if (host === 'youtu.be') {
      id = url.pathname.split('/').filter(Boolean)[0] ?? null;
    }
    return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? `yt:${id.toLowerCase()}` : null;
  } catch {
    return null;
  }
}

function compareArchiveRecordsNewest(a: ArchiveRecord, b: ArchiveRecord): number {
  const timeline = archiveTimelineSeconds(b) - archiveTimelineSeconds(a);
  if (timeline !== 0) return timeline;
  const completed = (b.completedAt ?? b.archivedAt) - (a.completedAt ?? a.archivedAt);
  if (completed !== 0) return completed;
  return (b.blobHash || b.jobId).localeCompare(a.blobHash || a.jobId);
}

function archiveTimelineSeconds(rec: ArchiveRecord): number {
  return rec.bookmarkSavedAt && rec.bookmarkSavedAt > 0 ? rec.bookmarkSavedAt : rec.archivedAt;
}
