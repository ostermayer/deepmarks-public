import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

import { enqueueLifetimeArchive } from './archive-purchase.js';
import { bookmarkEventToJson, queryRelaysWithTimeout, type BookmarkJson } from './api-helpers.js';
import type { BlossomBlobStore } from './blossom-blob-store.js';
import { normalizeMirrorUrls } from './mirror-urls.js';
import { listCachedPublicBookmarks } from './public-bookmark-cache.js';
import type { Deps } from './route-deps.js';
import { validateSafePublicHttpUrl } from './safe-url.js';

export const ARCHIVE_DELETE_QUEUE = 'dm:archive:delete:queue';

export interface ArchiveRecord {
  jobId: string;
  ownerPubkey: string;
  url: string;
  blobHash: string;
  source?: string;
  tier: 'public' | 'private' | string;
  archivedAt: number;
  thumbHash?: string;
  mirrors?: Array<{ url: string; ok: boolean; error?: string }>;
}

export interface ArchiveDeleteJob {
  ownerPubkey: string;
  blobHash: string;
  mirrorUrls: string[];
  reason: 'archive-delete' | 'account-delete';
  requestedAt: number;
  url?: string;
  jobId?: string;
  attempt?: number;
}

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
      blobHash: parsed.blobHash ?? blobHash,
      source: parsed.source,
      tier: parsed.tier ?? 'unknown',
      archivedAt: parsed.archivedAt ?? 0,
      thumbHash: parsed.thumbHash,
      mirrors: Array.isArray(parsed.mirrors) ? parsed.mirrors : [],
    };
  } catch {
    return null;
  }
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
  archive: Pick<ArchiveRecord, 'blobHash' | 'thumbHash'>,
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

  try {
    await blobStore.delete(archive.blobHash);
    result.primaryDeleted = true;
  } catch (err) {
    result.errors.push((err as Error).message ?? 'primary delete failed');
  }

  if (archive.thumbHash) {
    try {
      await blobStore.delete(archive.thumbHash);
      result.thumbDeleted = true;
    } catch (err) {
      result.errors.push((err as Error).message ?? 'thumbnail delete failed');
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
    const primary = await deletePrimaryArchiveBlobs(opts.blobStore, record);
    if (primary.primaryDeleted) primaryDeleted += 1;
    if (primary.thumbDeleted) thumbDeleted += 1;
    errors.push(...primary.errors.map((e) => `${record.blobHash}: ${e}`));
    if (await enqueueArchiveMirrorDelete(opts.redis, record, 'account-delete')) {
      mirrorDeleteJobs += 1;
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
    const dedupeKey = `dm:archive-backfill:item:${pubkey}:${shortHash(bookmark.url)}`;
    const claim = await deps.redis.set(dedupeKey, '1', 'EX', 60 * 60 * 24 * 30, 'NX');
    if (claim !== 'OK') {
      skipped += 1;
      continue;
    }
    try {
      await enqueueLifetimeArchive({
        purchases: deps.purchases,
        url: bookmark.url,
        userPubkey: pubkey,
        eventId: bookmark.id,
        tier: 'public',
      });
      enqueued += 1;
    } catch (err) {
      skipped += 1;
      await deps.redis.del(dedupeKey).catch(() => {});
      deps.app.log.warn({ err, pubkey, url: bookmark.url }, 'lifetime archive backfill enqueue failed');
    }
  }

  return { enqueued, skipped, scanned: cached.length + relayEvents.length, locked: false };
}

function upsertCandidate(byUrl: Map<string, BookmarkJson>, bookmark: BookmarkJson): void {
  if (!bookmark.url) return;
  const existing = byUrl.get(bookmark.url);
  if (!existing || bookmark.savedAt > existing.savedAt || (
    bookmark.savedAt === existing.savedAt && bookmark.id > existing.id
  )) {
    byUrl.set(bookmark.url, bookmark);
  }
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
