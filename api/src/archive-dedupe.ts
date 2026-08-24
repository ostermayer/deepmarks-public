import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { createLifetimeArchiveJobId } from './archive-purchase.js';

const DEFAULT_ARCHIVE_DEDUPE_PREFIX = 'dm:archive-default:item:';
const DEFAULT_ARCHIVE_DEDUPE_TTL_SECONDS = 6 * 60 * 60;

export interface ArchiveDedupeClaim {
  claimed: boolean;
  jobId: string;
}

export async function claimDefaultArchiveJob(
  redis: Redis,
  pubkey: string,
  url: string,
): Promise<ArchiveDedupeClaim> {
  const jobId = createLifetimeArchiveJobId();
  const key = defaultArchiveDedupeKey(pubkey, url);
  const claim = await redis.set(key, jobId, 'EX', DEFAULT_ARCHIVE_DEDUPE_TTL_SECONDS, 'NX');
  if (claim === 'OK') return { claimed: true, jobId };
  const existing = await redis.get(key);
  return {
    claimed: false,
    jobId: existing && /^lifetime:[0-9a-f]{32}$/.test(existing) ? existing : jobId,
  };
}

export async function releaseDefaultArchiveJob(redis: Redis, pubkey: string, url: string, jobId: string): Promise<void> {
  const key = defaultArchiveDedupeKey(pubkey, url);
  const current = await redis.get(key);
  if (current === jobId) await redis.del(key);
}

function defaultArchiveDedupeKey(pubkey: string, url: string): string {
  return `${DEFAULT_ARCHIVE_DEDUPE_PREFIX}${pubkey}:${createHash('sha256').update(url).digest('hex')}`;
}

/** True when an explicit save recently claimed this owner+URL (the 6-hour
 *  default-archive window). Bulk backfills consult this so they can't mint a
 *  duplicate job for a URL the user just archived — the two claim namespaces
 *  used to be mutually invisible. */
export async function hasDefaultArchiveClaim(
  redis: Redis,
  pubkey: string,
  url: string,
): Promise<boolean> {
  return (await redis.exists(defaultArchiveDedupeKey(pubkey, url))) === 1;
}

// ── pending-archive claim ──────────────────────────────────────────────
//
// Held for the WHOLE lifetime of a queued/in-flight job, unlike the 6-hour
// default-archive claim above (whose TTL is shorter than a backed-up queue
// wait — the gap that let a looping client mint 40-58 duplicate jobs per
// URL on 2026-07-17, 88% of a 20.5k queue). Private-tier and media enqueues
// consult this; duplicates get the `queued:` sentinel instead of a new job.
// Released by the terminal /archive/callback; the TTL is only a backstop
// against a lost callback.

const PENDING_ARCHIVE_PREFIX = 'dm:archive-pending:item:';
export const PENDING_ARCHIVE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Media add-on jobs and webpage archives of the SAME URL are both
 *  legitimate (page + its video), so claims are namespaced per family. */
export type PendingArchiveFamily = 'lifetime' | 'media';

export interface PendingArchiveClaim {
  claimed: boolean;
  existingJobId?: string;
}

export async function claimPendingArchiveJob(
  redis: Redis,
  family: PendingArchiveFamily,
  pubkey: string,
  url: string,
  jobId: string,
): Promise<PendingArchiveClaim> {
  const key = pendingArchiveClaimKey(family, pubkey, url);
  const claim = await redis.set(key, jobId, 'EX', PENDING_ARCHIVE_TTL_SECONDS, 'NX');
  if (claim === 'OK') return { claimed: true };
  const existing = await redis.get(key);
  return { claimed: false, existingJobId: existing ?? undefined };
}

/** Value-matched release: a claim re-taken by a NEWER job (e.g. after the
 *  TTL backstop lapsed mid-flight) is never clobbered by the old job's
 *  terminal callback. */
export async function releasePendingArchiveJob(
  redis: Redis,
  family: PendingArchiveFamily,
  pubkey: string,
  url: string,
  jobId: string,
): Promise<void> {
  const key = pendingArchiveClaimKey(family, pubkey, url);
  const current = await redis.get(key);
  if (current === jobId) await redis.del(key);
}

export function pendingArchiveClaimKey(
  family: PendingArchiveFamily,
  pubkey: string,
  url: string,
): string {
  return `${PENDING_ARCHIVE_PREFIX}${family}:${pubkey}:${createHash('sha256').update(url).digest('hex')}`;
}
