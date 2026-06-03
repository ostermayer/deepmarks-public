import {
  archiveStatus,
  type ArchiveRecord,
  type ArchiveStatus,
  getMediaArchiveAddonStatus,
  startMediaArchive,
} from './archive.js';
import { scheduleArchiveKeyReconcileSoon } from './archive-key-reconciler.js';
import { generateArchiveKey, publishPendingArchiveKey, stashPendingKey } from './archive-keys.js';

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

interface MediaBookmark {
  url: string;
  eventId?: string;
  savedAt?: number;
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
  return MEDIA_HOST_PATTERNS.some((re) => re.test(parsed.hostname));
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

export async function maybeStartMediaArchiveForBookmark(input: {
  url: string;
  nsecHex: string;
  pubkey: string;
  eventId?: string;
  bookmarkSavedAt?: number;
}): Promise<boolean> {
  if (!isPotentialMediaUrl(input.url)) return false;
  const status = await getMediaArchiveAddonStatus(input.nsecHex);
  if (!status.purchased) return false;
  if (!await claimQueued(input.url)) return false;
  try {
    const archiveKey = generateArchiveKey();
    const result = await startMediaArchive({
      url: input.url,
      archiveKey,
      eventId: input.eventId,
      bookmarkSavedAt: input.bookmarkSavedAt,
    }, input.nsecHex);
    await rememberQueued(input.url, result.jobId, result.canonicalUrl);
    await stashPendingKey(result.jobId, archiveKey);
    await publishPendingArchiveKey(result.jobId, archiveKey, input.nsecHex, input.pubkey).catch(() => undefined);
    scheduleArchiveKeyReconcileSoon();
    return true;
  } catch (err) {
    await clearQueued(input.url);
    throw err;
  }
}

export async function queueEligibleMediaArchiveBackfill(input: {
  bookmarks: readonly MediaBookmark[];
  archives: readonly ArchiveRecord[];
  nsecHex: string;
  pubkey: string;
}): Promise<{ queued: number; skipped: number }> {
  const status = await getMediaArchiveAddonStatus(input.nsecHex).catch(() => null);
  if (!status?.purchased) return { queued: 0, skipped: 0 };
  await refreshQueuedMediaArchiveStatuses(input.archives, 50);

  const archived = new Set(
    input.archives
      .filter(isMediaArchiveRecord)
      .map((record) => mediaArchiveIdentity(record.url)),
  );
  const byId = new Map<string, MediaBookmark>();
  for (const bookmark of input.bookmarks) {
    if (!isPotentialMediaUrl(bookmark.url)) continue;
    const id = mediaArchiveIdentity(bookmark.url);
    if (!byId.has(id)) byId.set(id, bookmark);
  }

  let queued = 0;
  let skipped = 0;
  for (const bookmark of byId.values()) {
    if (queued >= MAX_BACKLOG_ENQUEUE_PER_PASS) break;
    if (archived.has(mediaArchiveIdentity(bookmark.url)) || await isQueued(bookmark.url)) {
      skipped += 1;
      continue;
    }
    try {
      if (await queueOneMediaArchive({
        url: bookmark.url,
        nsecHex: input.nsecHex,
        pubkey: input.pubkey,
        eventId: bookmark.eventId,
        bookmarkSavedAt: bookmark.savedAt,
      })) queued += 1;
    } catch {
      skipped += 1;
    }
  }
  return { queued, skipped };
}

async function queueOneMediaArchive(input: {
  url: string;
  nsecHex: string;
  pubkey: string;
  eventId?: string;
  bookmarkSavedAt?: number;
}): Promise<boolean> {
  if (!await claimQueued(input.url)) return false;
  try {
    const archiveKey = generateArchiveKey();
    const result = await startMediaArchive({
      url: input.url,
      archiveKey,
      eventId: input.eventId,
      bookmarkSavedAt: input.bookmarkSavedAt,
    }, input.nsecHex);
    await rememberQueued(input.url, result.jobId, result.canonicalUrl);
    await stashPendingKey(result.jobId, archiveKey);
    await publishPendingArchiveKey(result.jobId, archiveKey, input.nsecHex, input.pubkey).catch(() => undefined);
    scheduleArchiveKeyReconcileSoon();
    return true;
  } catch (err) {
    await clearQueued(input.url);
    throw err;
  }
}

async function refreshQueuedMediaArchiveStatuses(
  archives: readonly ArchiveRecord[] = [],
  limit = 25,
): Promise<{ checked: number; completed: number; failed: number }> {
  const completedIds = new Set(
    archives
      .filter(isMediaArchiveRecord)
      .map((record) => mediaArchiveIdentity(record.url)),
  );
  let checked = 0;
  let completed = 0;
  let failed = 0;
  const entries = await readAllQueued();
  for (const item of entries) {
    if (completedIds.has(item.identity)) {
      await removeStorageKey(item.storageKey);
      completed += 1;
    } else if (!item.entry.jobId && Date.now() - item.entry.queuedAt > UNKNOWN_QUEUE_TTL_MS) {
      await removeStorageKey(item.storageKey);
    }
  }

  const candidates = (await readAllQueued())
    .filter((item) => !!item.entry.jobId && item.entry.state !== 'failed')
    .sort((a, b) => (a.entry.lastCheckedAt ?? 0) - (b.entry.lastCheckedAt ?? 0))
    .slice(0, limit);
  await Promise.all(candidates.map(async (item) => {
    try {
      const status = await archiveStatus(item.entry.jobId!);
      checked += 1;
      if (status.state === 'done' || status.status === 'archived' || status.status === 'done') {
        await removeStorageKey(item.storageKey);
        completed += 1;
      } else if (status.state === 'failed' || status.status === 'failed') {
        await removeStorageKey(item.storageKey);
        failed += 1;
      } else {
        await saveStorageEntry(item.storageKey, {
          ...item.entry,
          state: status.state ?? statusToState(status.status),
          lastCheckedAt: Date.now(),
          error: undefined,
        });
      }
    } catch (error) {
      if (error instanceof Error && /archive status 404/.test(error.message)) {
        await removeStorageKey(item.storageKey);
      } else {
        await saveStorageEntry(item.storageKey, {
          ...item.entry,
          lastCheckedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }));
  return { checked, completed, failed };
}

async function isQueued(url: string): Promise<boolean> {
  const entry = await readQueued(url);
  return !!entry && entry.state !== 'failed';
}

async function claimQueued(url: string): Promise<boolean> {
  if (await isQueued(url)) return false;
  await markQueued(url, { queuedAt: Date.now() });
  return true;
}

async function rememberQueued(url: string, jobId: string, canonicalUrl?: string): Promise<void> {
  await markQueued(url, {
    queuedAt: Date.now(),
    jobId,
    canonicalUrl,
    state: 'queued',
    lastCheckedAt: Date.now(),
  });
}

async function markQueued(url: string, entry: QueuedMediaArchiveEntry): Promise<void> {
  const keys = queueKeysForUrl(url);
  const primary = keys[0];
  if (!primary) return;
  const legacy = keys.slice(1);
  await chrome.storage.local.set({ [primary]: entry });
  if (legacy.length > 0) await chrome.storage.local.remove(legacy);
}

async function clearQueued(url: string): Promise<void> {
  await chrome.storage.local.remove(queueKeysForUrl(url));
}

async function readQueued(url: string): Promise<QueuedMediaArchiveEntry | null> {
  const keys = queueKeysForUrl(url);
  const raw = await chrome.storage.local.get(keys);
  for (const key of keys) {
    const entry = normalizeQueued(raw[key]);
    if (!entry) continue;
    const ttl = entry.jobId ? QUEUED_TTL_MS : UNKNOWN_QUEUE_TTL_MS;
    if (Date.now() - entry.queuedAt < ttl) return entry;
    await removeStorageKey(key);
  }
  return null;
}

async function readAllQueued(): Promise<Array<{
  storageKey: string;
  identity: string;
  entry: QueuedMediaArchiveEntry;
}>> {
  const raw = await chrome.storage.local.get(null);
  const out: Array<{ storageKey: string; identity: string; entry: QueuedMediaArchiveEntry }> = [];
  for (const [storageKey, value] of Object.entries(raw)) {
    if (!storageKey.startsWith(QUEUED_PREFIX)) continue;
    const entry = normalizeQueued(value);
    if (!entry) continue;
    const suffix = storageKey.slice(QUEUED_PREFIX.length);
    const identity = suffix.startsWith('yt:') || suffix.startsWith('url:')
      ? suffix
      : mediaArchiveIdentity(suffix);
    const ttl = entry.jobId ? QUEUED_TTL_MS : UNKNOWN_QUEUE_TTL_MS;
    if (Date.now() - entry.queuedAt < ttl) out.push({ storageKey, identity, entry });
    else await removeStorageKey(storageKey);
  }
  return out;
}

function normalizeQueued(value: unknown): QueuedMediaArchiveEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<QueuedMediaArchiveEntry>;
  if (typeof candidate.queuedAt !== 'number' || !Number.isFinite(candidate.queuedAt)) return null;
  return {
    queuedAt: candidate.queuedAt,
    jobId: typeof candidate.jobId === 'string' ? candidate.jobId : undefined,
    canonicalUrl: typeof candidate.canonicalUrl === 'string' ? candidate.canonicalUrl : undefined,
    state: isArchiveState(candidate.state) ? candidate.state : undefined,
    lastCheckedAt: typeof candidate.lastCheckedAt === 'number' ? candidate.lastCheckedAt : undefined,
    error: typeof candidate.error === 'string' ? candidate.error : undefined,
  };
}

async function saveStorageEntry(storageKey: string, entry: QueuedMediaArchiveEntry): Promise<void> {
  await chrome.storage.local.set({ [storageKey]: entry });
}

async function removeStorageKey(storageKey: string): Promise<void> {
  await chrome.storage.local.remove(storageKey);
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

function statusToState(status: ArchiveStatus['status']): ArchiveStatus['state'] {
  if (status === 'archived' || status === 'done') return 'done';
  if (status === 'enqueued' || status === 'queued') return 'queued';
  if (status === 'expired' || status === 'failed') return 'failed';
  if (status === 'archiving' || status === 'mirroring' || status === 'pending-payment') return status;
  return undefined;
}

function isArchiveState(value: unknown): value is ArchiveStatus['state'] {
  return value === 'pending-payment' ||
    value === 'queued' ||
    value === 'archiving' ||
    value === 'mirroring' ||
    value === 'done' ||
    value === 'failed';
}
