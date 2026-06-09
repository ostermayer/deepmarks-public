import { get } from 'svelte/store';
import { api, ApiError, type ArchiveRecord, type ArchiveStatus } from '$lib/api/client';
import { assertArchiveKeySignerReady, generateArchiveKey, publishPendingArchiveKey, stashPendingArchiveKey } from '$lib/nostr/archive-keys';
import type { ParsedBookmark } from '$lib/nostr/bookmarks';
import { session } from '$lib/stores/session';

const QUEUED_PREFIX = 'deepmarks-media-archive-queued:v1:';
const QUEUED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UNKNOWN_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BACKLOG_ENQUEUE_PER_PASS = 12;

const MEDIA_HOST_PATTERNS = [
  /(^|\.)youtube\.com$/i,
  /^youtu\.be$/i,
  /(^|\.)vimeo\.com$/i,
  /(^|\.)rumble\.com$/i,
  /(^|\.)odysee\.com$/i,
  /(^|\.)lbry\.tv$/i,
  /(^|\.)twitch\.tv$/i,
  /(^|\.)tiktok\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)reddit\.com$/i,
  /(^|\.)redd\.it$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)imgur\.com$/i,
  /(^|\.)tilvids\.com$/i,
  /(^|\.)tube\.tchncs\.de$/i,
  /(^|\.)video\.nostr\.build$/i,
  /(^|\.)podcasts\.apple\.com$/i,
  /(^|\.)overcast\.fm$/i,
  /(^|\.)podbean\.com$/i,
  /(^|\.)libsyn\.com$/i,
  /(^|\.)buzzsprout\.com$/i,
  /(^|\.)simplecast\.com$/i,
  /(^|\.)transistor\.fm$/i,
  /(^|\.)captivate\.fm$/i,
];

const AUDIO_FILE_RE = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac)(?:$|[?#])/i;
const VIDEO_FILE_RE = /\.(mp4|m4v|mov|webm|mkv|ogv|mpeg|mpg|avi|3gp)(?:$|[?#])/i;
const IMAGE_FILE_RE = /\.(jpe?g|png|webp|avif|gif|heic|heif|tiff?|svg)(?:$|[?#])/i;
const STREAM_FILE_RE = /\.(m3u8|mpd)(?:$|[?#])/i;
const BLOSSOM_BLOB_RE = /^\/[0-9a-f]{64}(?:$|[/?#])/i;
const PEERTUBE_PATH_RE = /^\/(?:w|videos\/watch)\/[a-z0-9-]{8,}(?:$|[/?#])/i;

export interface MediaArchiveCounts {
  eligible: number;
  archived: number;
  queued: number;
}

interface QueuedMediaArchiveEntry {
  queuedAt: number;
  jobId?: string;
  canonicalUrl?: string;
  state?: ArchiveStatus['state'];
  lastCheckedAt?: number;
  error?: string;
}

export function isPotentialMediaUrl(raw: string): boolean {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (AUDIO_FILE_RE.test(parsed.pathname) || VIDEO_FILE_RE.test(parsed.pathname) || IMAGE_FILE_RE.test(parsed.pathname) || STREAM_FILE_RE.test(parsed.pathname)) return true;
  if (/blossom/i.test(parsed.hostname) && BLOSSOM_BLOB_RE.test(parsed.pathname)) return true;
  if (isLikelyPeerTubeUrl(parsed)) return true;
  if (isYoutubeHost(parsed)) return parseYoutubeVideoId(parsed) !== null;
  return MEDIA_HOST_PATTERNS.some((re) => re.test(parsed.hostname));
}

function isYoutubeHost(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
}

function isLikelyPeerTubeUrl(parsed: URL): boolean {
  if (!PEERTUBE_PATH_RE.test(parsed.pathname)) return false;
  const host = parsed.hostname.toLowerCase();
  return host.includes('peertube') || host.includes('tube') || host.endsWith('.video');
}

export function isMediaArchiveRecord(record: ArchiveRecord | undefined): boolean {
  if (!record) return false;
  const kind = (record.kind ?? '').toLowerCase();
  if (kind === 'media' || kind === 'video' || kind === 'youtube') return true;
  return /^audio\//i.test(record.contentType ?? '') || /^video\//i.test(record.contentType ?? '') || /^image\//i.test(record.contentType ?? '');
}

export function mediaArchiveCounts(
  bookmarks: readonly ParsedBookmark[],
  archives: readonly ArchiveRecord[],
): MediaArchiveCounts {
  const eligibleIds = new Set(bookmarks.map((b) => b.url).filter(isPotentialMediaUrl).map(mediaArchiveIdentity));
  const queuedIds = new Set<string>();
  const archivedIds = new Set<string>();
  for (const record of archives) {
    if (isMediaArchiveRecord(record)) archivedIds.add(mediaArchiveIdentity(record.url));
  }
  for (const bookmark of bookmarks) {
    if (!isPotentialMediaUrl(bookmark.url)) continue;
    const id = mediaArchiveIdentity(bookmark.url);
    if (eligibleIds.has(id) && !archivedIds.has(id) && isMediaQueued(bookmark.url)) queuedIds.add(id);
  }
  return {
    eligible: eligibleIds.size,
    archived: [...archivedIds].filter((id) => eligibleIds.has(id)).length,
    queued: queuedIds.size,
  };
}

export async function maybeQueueMediaArchiveForBookmark(input: {
  bookmark?: ParsedBookmark;
  url: string;
  pubkey?: string | null;
  eventId?: string;
  bookmarkSavedAt?: number;
}): Promise<boolean> {
  const pubkey = input.pubkey ?? get(session).pubkey;
  if (!pubkey || !isPotentialMediaUrl(input.url)) return false;
  if (isMediaQueued(input.url)) return false;
  const status = await api.mediaArchive.status();
  if (!status.purchased) return false;
  return queueOneMediaArchive({
    url: input.url,
    pubkey,
    eventId: input.eventId ?? input.bookmark?.eventId,
    bookmarkSavedAt: input.bookmarkSavedAt ?? input.bookmark?.savedAt,
  });
}

export async function queueEligibleMediaArchives(
  bookmarks: readonly ParsedBookmark[],
  archives: readonly ArchiveRecord[],
): Promise<{ queued: number; skipped: number }> {
  const pubkey = get(session).pubkey;
  const status = await api.mediaArchive.status();
  if (!status.purchased) return { queued: 0, skipped: 0 };
  await refreshQueuedMediaArchiveStatuses(archives, 50);

  const archived = new Set(
    archives
      .filter(isMediaArchiveRecord)
      .map((record) => mediaArchiveIdentity(record.url)),
  );
  const byUrl = new Map<string, ParsedBookmark>();
  for (const bookmark of bookmarks) {
    if (!isPotentialMediaUrl(bookmark.url)) continue;
    const id = mediaArchiveIdentity(bookmark.url);
    if (!byUrl.has(id)) byUrl.set(id, bookmark);
  }

  let queued = 0;
  let skipped = 0;
  for (const bookmark of byUrl.values()) {
    if (queued >= MAX_BACKLOG_ENQUEUE_PER_PASS) break;
    if (archived.has(mediaArchiveIdentity(bookmark.url)) || isMediaQueued(bookmark.url)) {
      skipped += 1;
      continue;
    }
    try {
      if (await queueOneMediaArchive({
        url: bookmark.url,
        pubkey,
        eventId: bookmark.eventId,
        bookmarkSavedAt: bookmark.savedAt,
      })) queued += 1;
    } catch {
      skipped += 1;
    }
  }
  return { queued, skipped };
}

/** Re-enqueue a media archive whose AES key is unrecoverable on this
 *  device — produces a fresh key + fresh job through the normal media
 *  pipeline. Used by the missing-key backfill (media records were
 *  previously excluded entirely and just disappeared). */
export async function requeueMediaArchiveWithFreshKey(input: {
  url: string;
  pubkey?: string | null;
  eventId?: string;
  bookmarkSavedAt?: number;
}): Promise<boolean> {
  return queueOneMediaArchive(input);
}

async function queueOneMediaArchive(input: {
  url: string;
  pubkey?: string | null;
  eventId?: string;
  bookmarkSavedAt?: number;
}): Promise<boolean> {
  if (!claimMediaQueueSlot(input.url)) return false;
  try {
    const archiveKey = generateArchiveKey();
    // Media archives are ALWAYS encrypted — same key-orphan risk as
    // private page archives when the signer can't publish the wrap.
    if (input.pubkey) await assertArchiveKeySignerReady(input.pubkey);
    const result = await api.mediaArchive.enqueue({
      url: input.url,
      archiveKey,
      eventId: input.eventId,
      bookmarkSavedAt: input.bookmarkSavedAt,
    });
    rememberMediaQueueJob(input.url, result.jobId, result.canonicalUrl);
    stashPendingArchiveKey(result.jobId, archiveKey);
    if (input.pubkey) {
      await publishPendingArchiveKey(result.jobId, archiveKey, input.pubkey).catch((error) => {
        console.warn('Deepmarks media archive key pre-sync failed; local stash will retry later:', error);
      });
    }
    return true;
  } catch (err) {
    unmarkMediaQueued(input.url);
    throw err;
  }
}

export async function refreshQueuedMediaArchiveStatuses(
  archives: readonly ArchiveRecord[] = [],
  limit = 25,
): Promise<{ checked: number; completed: number; failed: number }> {
  if (typeof localStorage === 'undefined') return { checked: 0, completed: 0, failed: 0 };
  const completedIds = new Set(
    archives
      .filter(isMediaArchiveRecord)
      .map((record) => mediaArchiveIdentity(record.url)),
  );
  let checked = 0;
  let completed = 0;
  let failed = 0;
  const entries = loadAllQueuedMediaEntries();
  for (const item of entries) {
    if (completedIds.has(item.identity)) {
      removeMediaStorageKey(item.storageKey);
      completed += 1;
    } else if (!item.entry.jobId && Date.now() - item.entry.queuedAt > UNKNOWN_QUEUE_TTL_MS) {
      removeMediaStorageKey(item.storageKey);
    }
  }

  const candidates = loadAllQueuedMediaEntries()
    .filter((item) => !!item.entry.jobId && item.entry.state !== 'failed')
    .sort((a, b) => (a.entry.lastCheckedAt ?? 0) - (b.entry.lastCheckedAt ?? 0))
    .slice(0, limit);
  await Promise.all(candidates.map(async (item) => {
    try {
      const status = await api.archiveStatus(item.entry.jobId!);
      checked += 1;
      if (status.state === 'done') {
        removeMediaStorageKey(item.storageKey);
        completed += 1;
      } else if (status.state === 'failed') {
        removeMediaStorageKey(item.storageKey);
        failed += 1;
      } else {
        saveMediaStorageEntry(item.storageKey, {
          ...item.entry,
          state: status.state,
          lastCheckedAt: Date.now(),
          error: undefined,
        });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        removeMediaStorageKey(item.storageKey);
      } else {
        saveMediaStorageEntry(item.storageKey, {
          ...item.entry,
          lastCheckedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }));
  return { checked, completed, failed };
}

function isMediaQueued(url: string): boolean {
  const entry = loadQueuedMediaEntry(url);
  return !!entry && entry.state !== 'failed';
}

function claimMediaQueueSlot(url: string): boolean {
  if (isMediaQueued(url)) return false;
  markMediaQueued(url, { queuedAt: Date.now() });
  return true;
}

function rememberMediaQueueJob(url: string, jobId: string, canonicalUrl?: string): void {
  markMediaQueued(url, {
    queuedAt: Date.now(),
    jobId,
    canonicalUrl,
    state: 'queued',
    lastCheckedAt: Date.now(),
  });
}

function markMediaQueued(url: string, entry: QueuedMediaArchiveEntry): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const keys = queueKeysForUrl(url);
    const primary = keys[0];
    if (!primary) return;
    const legacy = keys.slice(1);
    localStorage.setItem(primary, JSON.stringify(entry));
    for (const key of legacy) localStorage.removeItem(key);
  } catch {
    // Non-fatal; server-side queue still owns truth after enqueue.
  }
}

function unmarkMediaQueued(url: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    for (const key of queueKeysForUrl(url)) localStorage.removeItem(key);
  } catch {
    // Non-fatal.
  }
}

function loadQueuedMediaEntry(url: string): QueuedMediaArchiveEntry | null {
  if (typeof localStorage === 'undefined') return null;
  for (const key of queueKeysForUrl(url)) {
    const entry = normalizeQueuedMediaEntry(localStorage.getItem(key));
    if (!entry) continue;
    const ttl = entry.jobId ? QUEUED_TTL_MS : UNKNOWN_QUEUE_TTL_MS;
    if (Date.now() - entry.queuedAt < ttl) return entry;
    removeMediaStorageKey(key);
  }
  return null;
}

function loadAllQueuedMediaEntries(): Array<{
  storageKey: string;
  identity: string;
  entry: QueuedMediaArchiveEntry;
}> {
  if (typeof localStorage === 'undefined') return [];
  const out: Array<{ storageKey: string; identity: string; entry: QueuedMediaArchiveEntry }> = [];
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(QUEUED_PREFIX)) keys.push(key);
  }
  for (const storageKey of keys) {
    const entry = normalizeQueuedMediaEntry(localStorage.getItem(storageKey));
    if (!entry) continue;
    const suffix = storageKey.slice(QUEUED_PREFIX.length);
    const identity = suffix.startsWith('yt:') || suffix.startsWith('url:')
      ? suffix
      : mediaArchiveIdentity(suffix);
    const ttl = entry.jobId ? QUEUED_TTL_MS : UNKNOWN_QUEUE_TTL_MS;
    if (Date.now() - entry.queuedAt < ttl) out.push({ storageKey, identity, entry });
    else removeMediaStorageKey(storageKey);
  }
  return out;
}

function normalizeQueuedMediaEntry(raw: string | null): QueuedMediaArchiveEntry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<QueuedMediaArchiveEntry>;
    if (typeof candidate.queuedAt !== 'number' || !Number.isFinite(candidate.queuedAt)) return null;
    const state = candidate.state && isArchiveState(candidate.state) ? candidate.state : undefined;
    return {
      queuedAt: candidate.queuedAt,
      jobId: typeof candidate.jobId === 'string' ? candidate.jobId : undefined,
      canonicalUrl: typeof candidate.canonicalUrl === 'string' ? candidate.canonicalUrl : undefined,
      state,
      lastCheckedAt: typeof candidate.lastCheckedAt === 'number' ? candidate.lastCheckedAt : undefined,
      error: typeof candidate.error === 'string' ? candidate.error : undefined,
    };
  } catch {
    return null;
  }
}

function saveMediaStorageEntry(storageKey: string, entry: QueuedMediaArchiveEntry): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(entry));
  } catch {
    // Non-fatal; server-side queue still owns truth after enqueue.
  }
}

function removeMediaStorageKey(storageKey: string): void {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // Non-fatal.
  }
}

function queueKeysForUrl(url: string): string[] {
  const primary = `${QUEUED_PREFIX}${mediaArchiveIdentity(url)}`;
  const legacy = `${QUEUED_PREFIX}${url}`;
  return primary === legacy ? [primary] : [primary, legacy];
}

function mediaArchiveIdentity(raw: string): string {
  try {
    const parsed = new URL(raw);
    const youtubeId = parseYoutubeVideoId(parsed);
    if (youtubeId) return `yt:${youtubeId.toLowerCase()}`;
    parsed.hash = '';
    return `url:${parsed.toString()}`;
  } catch {
    return `url:${raw}`;
  }
}

function parseYoutubeVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return isYoutubeId(id) ? id : null;
  }
  if (!(host === 'youtube.com' || host.endsWith('.youtube.com'))) return null;
  const watch = url.searchParams.get('v');
  if (isYoutubeId(watch)) return watch;
  const parts = url.pathname.split('/').filter(Boolean);
  if ((parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live') && isYoutubeId(parts[1])) {
    return parts[1];
  }
  return null;
}

function isYoutubeId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(value);
}

function isArchiveState(value: unknown): value is ArchiveStatus['state'] {
  return value === 'pending-payment' ||
    value === 'queued' ||
    value === 'archiving' ||
    value === 'mirroring' ||
    value === 'done' ||
    value === 'failed';
}
