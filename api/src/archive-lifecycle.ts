import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

import { hasDefaultArchiveClaim } from './archive-dedupe.js';
import type { ArchiveDeleteJob } from './archive-wire.js';
import { getRecentArchiveFailure } from './archive-failures.js';
import { enqueueLifetimeArchive } from './archive-purchase.js';
import { removeArchiveRef } from './archive-refcount.js';
import type { PurchaseStore } from './queue.js';
import { bookmarkEventToJson, queryRelaysWithTimeout, type BookmarkJson } from './api-helpers.js';
import type { BlossomBlobStore } from './blossom-blob-store.js';
import { normalizeMirrorUrls } from './mirror-urls.js';
import { listCachedPublicBookmarks } from './public-bookmark-cache.js';
import type { Deps } from './route-deps.js';
import { validateSafePublicHttpUrl } from './safe-url.js';
import type { ArchiveFileRecord } from './types.js';

export const ARCHIVE_DELETE_QUEUE = 'dm:archive:delete:queue';

export interface ArchiveRecord {
  jobId: string;
  ownerPubkey: string;
  url: string;
  originalUrl?: string;
  blobHash: string;
  source?: string;
  tier: 'public' | 'private' | string;
  /** Timeline timestamp for archive lists. For bookmark-backed
   *  archives this is the original bookmark save time; legacy/API-only
   *  archives may use completion time. */
  archivedAt: number;
  /** Actual worker completion time, unix seconds. */
  completedAt?: number;
  /** Original bookmark save time, unix seconds, when known. */
  bookmarkSavedAt?: number;
  thumbHash?: string;
  /** Original MIME type of the archived payload. Public HTML archives
   *  are text/html; direct PDF/file archives are application/pdf. Private
   *  archives store encrypted bytes, but this tells clients which Blob
   *  MIME to use after decryption. */
  contentType?: string;
  fileName?: string;
  mirrors?: Array<{ url: string; ok: boolean; error?: string }>;
  kind?: 'webpage' | 'youtube' | 'video' | 'file' | string;
  videoId?: string;
  videoContentKey?: string;
  videoTitle?: string;
  videoChannel?: string;
  videoDurationSeconds?: number;
  /** Optional sibling files captured for the same logical archive,
   *  e.g. an HTML article snapshot plus the publisher's full-text PDF.
   *  blobHash remains the primary file for old clients. */
  files?: ArchiveFileRecord[];
}

/** Wire shape shared with the worker — canonical definition in
 *  packages/archive-wire/archive-wire.ts, re-exported here so existing
 *  importers keep working. */
export type { ArchiveDeleteJob } from './archive-wire.js';

export interface PrimaryArchiveDeleteResult {
  primaryDeleted: boolean;
  thumbDeleted: boolean;
  errors: string[];
}

export function parseArchiveRecord(
  blobHash: string,
  raw: string,
  expectedOwnerPubkey?: string,
): ArchiveRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ArchiveRecord>;
    const ownerPubkey = parsed.ownerPubkey ?? expectedOwnerPubkey;
    if (expectedOwnerPubkey && ownerPubkey && ownerPubkey !== expectedOwnerPubkey) return null;
    return {
      jobId: parsed.jobId ?? '',
      ownerPubkey: ownerPubkey ?? '',
      url: parsed.url ?? '',
      originalUrl: typeof parsed.originalUrl === 'string' ? parsed.originalUrl : undefined,
      blobHash: parsed.blobHash ?? blobHash,
      source: parsed.source,
      tier: parsed.tier ?? 'unknown',
      archivedAt: normalizeUnixSeconds(parsed.archivedAt) ?? 0,
      completedAt: normalizeUnixSeconds(parsed.completedAt),
      bookmarkSavedAt: normalizeUnixSeconds(parsed.bookmarkSavedAt),
      thumbHash: parsed.thumbHash,
      contentType: parsed.contentType,
      fileName: parsed.fileName,
      mirrors: Array.isArray(parsed.mirrors) ? parsed.mirrors : [],
      kind: parsed.kind,
      videoId: parsed.videoId,
      videoContentKey: parsed.videoContentKey,
      videoTitle: parsed.videoTitle,
      videoChannel: parsed.videoChannel,
      videoDurationSeconds: parsed.videoDurationSeconds,
      files: normalizeArchiveFiles(parsed.files, parsed.blobHash ?? blobHash, parsed.url ?? ''),
    };
  } catch {
    return null;
  }
}

export function archiveFilesForRecord(archive: Pick<ArchiveRecord, 'blobHash' | 'url' | 'source' | 'contentType' | 'fileName' | 'thumbHash' | 'mirrors' | 'kind' | 'files'>): ArchiveFileRecord[] {
  const files = normalizeArchiveFiles(archive.files, archive.blobHash, archive.url);
  if (files.length > 0) return files;
  return [{
    role: archiveFileRole(archive.kind, archive.contentType),
    blobHash: archive.blobHash,
    url: archive.url,
    source: archiveFileSource(archive.source),
    contentType: archive.contentType,
    fileName: archive.fileName,
    thumbHash: archive.thumbHash,
    mirrors: archive.mirrors,
  }];
}

function normalizeArchiveFiles(raw: unknown, primaryBlobHash: string, primaryUrl: string): ArchiveFileRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: ArchiveFileRecord[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<ArchiveFileRecord>;
    if (!record.blobHash || !/^[0-9a-f]{64}$/.test(record.blobHash)) continue;
    if (seen.has(record.blobHash)) continue;
    const role = record.role === 'html' || record.role === 'pdf' || record.role === 'file' || record.role === 'media'
      ? record.role
      : archiveFileRole(undefined, record.contentType);
    out.push({
      role,
      blobHash: record.blobHash,
      url: typeof record.url === 'string' && record.url ? record.url : primaryUrl,
      source: archiveFileSource(record.source),
      contentType: typeof record.contentType === 'string' ? record.contentType : undefined,
      fileName: typeof record.fileName === 'string' ? record.fileName : undefined,
      thumbHash: typeof record.thumbHash === 'string' ? record.thumbHash : undefined,
      mirrors: Array.isArray(record.mirrors) ? record.mirrors : undefined,
    });
    seen.add(record.blobHash);
  }
  if (out.length > 0 && !seen.has(primaryBlobHash) && /^[0-9a-f]{64}$/.test(primaryBlobHash)) {
    out.unshift({ role: 'html', blobHash: primaryBlobHash, url: primaryUrl });
  }
  return out;
}

function archiveFileRole(kind: unknown, contentType: unknown): ArchiveFileRecord['role'] {
  const type = typeof contentType === 'string' ? contentType.toLowerCase() : '';
  if (type.includes('application/pdf')) return 'pdf';
  if (kind === 'video' || kind === 'youtube' || kind === 'media' || type.startsWith('video/') || type.startsWith('audio/')) return 'media';
  if (kind === 'file') return 'file';
  return 'html';
}

function archiveFileSource(source: unknown): ArchiveFileRecord['source'] {
  return source === 'wayback' || source === 'rendered' || source === 'file' ? source : undefined;
}

export function archiveRecordTimelineAt(
  archive: Pick<ArchiveRecord, 'archivedAt' | 'bookmarkSavedAt'>,
): number {
  return normalizeUnixSeconds(archive.bookmarkSavedAt) ?? normalizeUnixSeconds(archive.archivedAt) ?? 0;
}

export function compareArchiveRecordsNewest<T extends Pick<ArchiveRecord, 'archivedAt' | 'bookmarkSavedAt' | 'completedAt' | 'blobHash' | 'jobId'>>(
  a: T,
  b: T,
): number {
  const timeline = archiveRecordTimelineAt(b) - archiveRecordTimelineAt(a);
  if (timeline !== 0) return timeline;
  const completed = (b.completedAt ?? b.archivedAt) - (a.completedAt ?? a.archivedAt);
  if (completed !== 0) return completed;
  return (b.blobHash || b.jobId).localeCompare(a.blobHash || a.jobId);
}

function normalizeUnixSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function listArchiveRecords(redis: Redis, pubkey: string): Promise<ArchiveRecord[]> {
  const raw = await redis.hgetall(`dm:archives:${pubkey}`);
  const out: ArchiveRecord[] = [];
  for (const [blobHash, json] of Object.entries(raw ?? {})) {
    const parsed = parseArchiveRecord(blobHash, json, pubkey);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function deletePrimaryArchiveBlobs(
  blobStore: BlossomBlobStore | null,
  archive: Pick<ArchiveRecord, 'blobHash' | 'url' | 'source' | 'contentType' | 'fileName' | 'thumbHash' | 'mirrors' | 'kind' | 'files'>,
): Promise<PrimaryArchiveDeleteResult> {
  const result: PrimaryArchiveDeleteResult = {
    primaryDeleted: false,
    thumbDeleted: false,
    errors: [],
  };
  if (!blobStore) {
    result.errors.push('blossom delete not configured on this server');
    return result;
  }

  const files = archiveFilesForRecord(archive);
  const primaryHashes = new Set(files.map((file) => file.blobHash));
  for (const blobHash of primaryHashes) {
    const file = files.find((item) => item.blobHash === blobHash);
    try {
      await blobStore.delete({
        blobHash,
        contentType: file?.contentType,
        fileName: file?.fileName,
        url: file?.url,
      });
      result.primaryDeleted = true;
    } catch (err) {
      result.errors.push(`${blobHash}: ${(err as Error).message ?? 'primary delete failed'}`);
    }
  }

  const thumbHashes = new Set(files.map((file) => file.thumbHash).filter((hash): hash is string => !!hash));
  if (archive.thumbHash) thumbHashes.add(archive.thumbHash);
  for (const thumbHash of thumbHashes) {
    try {
      await blobStore.delete({ blobHash: thumbHash, contentType: 'image/jpeg' });
      result.thumbDeleted = true;
    } catch (err) {
      result.errors.push(`${thumbHash}: ${(err as Error).message ?? 'thumbnail delete failed'}`);
    }
  }

  return result;
}

export function mirrorUrlsForArchive(archive: Pick<ArchiveRecord, 'mirrors'>): string[] {
  const raw = (archive.mirrors ?? [])
    .filter((m) => m?.ok && typeof m.url === 'string')
    .map((m) => m.url);
  const normalized = normalizeMirrorUrls(raw);
  return normalized.ok ? normalized.urls : [];
}

export async function enqueueArchiveMirrorDelete(
  redis: Redis,
  archive: Pick<ArchiveRecord, 'ownerPubkey' | 'blobHash' | 'url' | 'jobId' | 'mirrors'>,
  reason: ArchiveDeleteJob['reason'],
): Promise<boolean> {
  const mirrorUrls = mirrorUrlsForArchive(archive);
  if (mirrorUrls.length === 0) return false;
  const job: ArchiveDeleteJob = {
    ownerPubkey: archive.ownerPubkey,
    blobHash: archive.blobHash,
    mirrorUrls,
    reason,
    requestedAt: Math.floor(Date.now() / 1000),
    url: archive.url,
    jobId: archive.jobId,
    attempt: 0,
  };
  await redis.rpush(ARCHIVE_DELETE_QUEUE, JSON.stringify(job));
  return true;
}

export async function deleteAllArchivesForAccount(opts: {
  redis: Redis;
  blobStore: BlossomBlobStore | null;
  pubkey: string;
}): Promise<{
  archivesRemoved: number;
  primaryDeleted: number;
  thumbDeleted: number;
  mirrorDeleteJobs: number;
  errors: string[];
}> {
  const records = await listArchiveRecords(opts.redis, opts.pubkey);
  let primaryDeleted = 0;
  let thumbDeleted = 0;
  let mirrorDeleteJobs = 0;
  const errors: string[] = [];

  for (const record of records) {
    const files = archiveFilesForRecord(record);
    const filesToDelete: ArchiveFileRecord[] = [];
    for (const file of files) {
      const remaining = await removeArchiveRef(opts.redis, file.blobHash, opts.pubkey);
      if (remaining === 0) filesToDelete.push(file);
    }
    if (filesToDelete.length > 0) {
      const primary = await deletePrimaryArchiveBlobs(opts.blobStore, {
        ...record,
        blobHash: filesToDelete[0]!.blobHash,
        files: filesToDelete,
      });
      if (primary.primaryDeleted) primaryDeleted += 1;
      if (primary.thumbDeleted) thumbDeleted += 1;
      errors.push(...primary.errors.map((e) => `${record.blobHash}: ${e}`));
      for (const file of filesToDelete) {
        if (await enqueueArchiveMirrorDelete(opts.redis, {
          ...record,
          blobHash: file.blobHash,
          mirrors: file.mirrors ?? record.mirrors,
        }, 'account-delete')) {
          mirrorDeleteJobs += 1;
        }
      }
    }
  }

  if (records.length > 0) await opts.redis.del(`dm:archives:${opts.pubkey}`);
  return {
    archivesRemoved: records.length,
    primaryDeleted,
    thumbDeleted,
    mirrorDeleteJobs,
    errors,
  };
}

export type BackfillEnqueueOutcome = 'enqueued' | 'skipped' | 'failed';

/**
 * The one enqueue path for lifetime-archive backfills — the settlement sweep
 * below AND the LifetimeArchiveBackfillWorker feed candidates through here so
 * their skip rules can't drift (they used to be three hand-copied filters):
 * 1. terminal-failure gate — a URL that recently failed (permanent: 30-day
 *    window; retryable: escalating cooldown) fails identically on re-enqueue;
 * 2. cross-run dedupe — one backfill enqueue per owner+URL per 30 days, no
 *    matter which backfill surface fires.
 */
export async function enqueueLifetimeBackfillCandidate(opts: {
  redis: Redis;
  purchases: PurchaseStore;
  pubkey: string;
  url: string;
  eventId?: string;
  bookmarkSavedAt?: number;
  warn?: (obj: Record<string, unknown>, msg: string) => void;
}): Promise<BackfillEnqueueOutcome> {
  const { redis, purchases, pubkey, url } = opts;
  if (await getRecentArchiveFailure(redis, pubkey, url)) return 'skipped';
  // An explicit save just claimed this URL (6-hour window) — its job is
  // already in flight; a backfill enqueue would be a duplicate.
  if (await hasDefaultArchiveClaim(redis, pubkey, url)) return 'skipped';
  const dedupeKey = `dm:archive-backfill:item:${pubkey}:${shortHash(url)}`;
  const claim = await redis.set(dedupeKey, '1', 'EX', 60 * 60 * 24 * 30, 'NX');
  if (claim !== 'OK') return 'skipped';
  try {
    await enqueueLifetimeArchive({
      purchases,
      url,
      userPubkey: pubkey,
      eventId: opts.eventId,
      tier: 'public',
      bookmarkSavedAt: opts.bookmarkSavedAt,
    });
    return 'enqueued';
  } catch (err) {
    await redis.del(dedupeKey).catch(() => {});
    opts.warn?.({ err, pubkey, url }, 'lifetime archive backfill enqueue failed');
    return 'failed';
  }
}

export async function backfillLifetimePublicArchives(
  deps: Deps,
  pubkey: string,
): Promise<{ enqueued: number; skipped: number; scanned: number; locked: boolean }> {
  const lock = await deps.redis.set(
    `dm:archive-backfill:lock:${pubkey}`,
    '1',
    'EX',
    60 * 60,
    'NX',
  );
  if (lock !== 'OK') return { enqueued: 0, skipped: 0, scanned: 0, locked: true };

  let enqueued = 0;
  let skipped = 0;

  const existingArchives = await listArchiveRecords(deps.redis, pubkey);
  const archivedUrls = new Set(existingArchives.map((a) => a.url).filter(Boolean));

  const [cached, relayEvents] = await Promise.all([
    listCachedPublicBookmarks(deps.redis, pubkey, 5_000).catch(() => []),
    queryRelaysWithTimeout(
      deps.relayPool,
      [deps.INDEXER_RELAY_URL_FOR_API],
      { kinds: [39701], authors: [pubkey], limit: 5_000 },
      8_000,
    ).catch(() => []),
  ]);

  const byUrl = new Map<string, BookmarkJson>();
  for (const bookmark of cached) {
    upsertCandidate(byUrl, bookmark);
  }
  for (const event of relayEvents) {
    try {
      upsertCandidate(byUrl, bookmarkEventToJson(event));
    } catch {
      skipped += 1;
    }
  }

  const candidates = [...byUrl.values()]
    .filter((bookmark) => {
      if (!bookmark.url || archivedUrls.has(bookmark.url)) return false;
      if (bookmark.archivedForever || bookmark.blossomHash || bookmark.waybackUrl) return false;
      try {
        validateSafePublicHttpUrl(bookmark.url);
        return true;
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.savedAt - b.savedAt || a.id.localeCompare(b.id));

  for (const bookmark of candidates) {
    const outcome = await enqueueLifetimeBackfillCandidate({
      redis: deps.redis,
      purchases: deps.purchases,
      pubkey,
      url: bookmark.url,
      eventId: bookmark.id,
      bookmarkSavedAt: bookmark.savedAt,
      warn: (obj, msg) => deps.app.log.warn(obj, msg),
    });
    if (outcome === 'enqueued') enqueued += 1;
    else skipped += 1;
  }

  return { enqueued, skipped, scanned: cached.length + relayEvents.length, locked: false };
}

function upsertCandidate(byUrl: Map<string, BookmarkJson>, bookmark: BookmarkJson): void {
  if (!bookmark.url) return;
  const existing = byUrl.get(bookmark.url);
  const bookmarkReplaceTime = bookmark.eventCreatedAt ?? bookmark.savedAt;
  const existingReplaceTime = existing ? (existing.eventCreatedAt ?? existing.savedAt) : -1;
  if (!existing || bookmarkReplaceTime > existingReplaceTime || (
    bookmarkReplaceTime === existingReplaceTime && bookmark.id > existing.id
  )) {
    byUrl.set(bookmark.url, bookmark);
  }
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
