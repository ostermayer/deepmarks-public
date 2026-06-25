import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

import {
  ARCHIVE_FAILURE_PREFIX,
  listArchiveFailures,
  parseArchiveFailureRecord,
  type ArchiveFailureRecord,
} from './archive-failures.js';
import { createLifetimeArchiveJobId, enqueueLifetimeArchive } from './archive-purchase.js';
import type { PurchaseStore } from './queue.js';
import { validateSafePublicHttpUrl } from './safe-url.js';

const RETRY_CLAIM_PREFIX = 'dm:archive-terminal-retry:';
const RETRY_CLAIM_TTL_SECONDS = 24 * 60 * 60;
const MAX_RETRY_BATCH = 100;
const MAX_FAILURE_SCAN = 5_000;

export interface ArchiveTerminalRetryDeps {
  redis: Redis;
  purchases: PurchaseStore;
  logger?: {
    info?: (obj: Record<string, unknown>, msg?: string) => void;
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
  };
}

export interface ArchiveTerminalRetryOptions {
  ownerPubkey?: string;
  limit?: number;
  dryRun?: boolean;
  force?: boolean;
}

export interface ArchiveTerminalRetryResult {
  scanned: number;
  processed: number;
  enqueued: number;
  skipped: number;
  dryRun: boolean;
  results: ArchiveTerminalRetryItem[];
}

export interface ArchiveTerminalRetryItem {
  jobId: string;
  url: string;
  eligible: boolean;
  skippedReason?: string;
  retryJobId?: string;
}

export async function retryTerminalArchiveFailures(
  deps: ArchiveTerminalRetryDeps,
  options: ArchiveTerminalRetryOptions = {},
): Promise<ArchiveTerminalRetryResult> {
  const dryRun = options.dryRun ?? true;
  const limit = clampInt(options.limit, 1, MAX_RETRY_BATCH, 20);
  const failures = await listFailuresForRetry(deps.redis, options.ownerPubkey);
  const results: ArchiveTerminalRetryItem[] = [];
  let enqueued = 0;
  let skipped = 0;
  let eligibleSeen = 0;

  for (const failure of failures) {
    const eligibility = archiveFailureRetryEligibility(failure);
    if (!eligibility.eligible) {
      skipped += 1;
      results.push({
        jobId: failure.jobId,
        url: failure.url,
        eligible: false,
        skippedReason: eligibility.reason,
      });
      continue;
    }
    if (eligibleSeen >= limit) continue;
    eligibleSeen += 1;

    if (!dryRun && !options.force) {
      const claim = await deps.redis.set(
        retryClaimKey(failure),
        '1',
        'EX',
        RETRY_CLAIM_TTL_SECONDS,
        'NX',
      );
      if (claim !== 'OK') {
        skipped += 1;
        results.push({
          jobId: failure.jobId,
          url: failure.url,
          eligible: true,
          skippedReason: 'already-retried-recently',
        });
        continue;
      }
    }

    const retryJobId = createLifetimeArchiveJobId();
    if (!dryRun) {
      await enqueueLifetimeArchive({
        purchases: deps.purchases,
        paymentHash: retryJobId,
        url: failure.url,
        userPubkey: failure.ownerPubkey,
        eventId: failure.eventId,
        tier: 'public',
        mirrorUrls: failure.mirrorUrls,
        bookmarkSavedAt: failure.bookmarkSavedAt,
      });
      deps.logger?.info?.(
        { jobId: failure.jobId, retryJobId, url: failure.url, owner: failure.ownerPubkey },
        'terminal archive failure requeued',
      );
      enqueued += 1;
    }

    results.push({
      jobId: failure.jobId,
      url: failure.url,
      eligible: true,
      retryJobId,
    });
  }

  return {
    scanned: failures.length,
    processed: results.length,
    enqueued,
    skipped,
    dryRun,
    results,
  };
}

export function archiveFailureRetryEligibility(
  failure: ArchiveFailureRecord,
): { eligible: true } | { eligible: false; reason: string } {
  if (failure.tier === 'private') return { eligible: false, reason: 'private-archive' };
  if (failure.jobId.startsWith('rescue:')) return { eligible: false, reason: 'rescue-job' };
  const kind = failure.kind ?? 'webpage';
  if (kind !== 'webpage' && kind !== 'file') {
    return { eligible: false, reason: 'non-replayable-archive' };
  }
  try {
    validateSafePublicHttpUrl(failure.url);
  } catch {
    return { eligible: false, reason: 'unsafe-source-url' };
  }
  return { eligible: true };
}

async function listFailuresForRetry(
  redis: Redis,
  ownerPubkey: string | undefined,
): Promise<ArchiveFailureRecord[]> {
  if (ownerPubkey) return listArchiveFailures(redis, ownerPubkey);

  const failures: ArchiveFailureRecord[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${ARCHIVE_FAILURE_PREFIX}*`,
      'COUNT',
      100,
    );
    cursor = next;
    for (const key of keys) {
      const expectedOwner = key.slice(ARCHIVE_FAILURE_PREFIX.length);
      const raw = await redis.hgetall(key);
      for (const value of Object.values(raw ?? {})) {
        const parsed = parseArchiveFailureRecord(value, expectedOwner);
        if (parsed) failures.push(parsed);
      }
      if (failures.length >= MAX_FAILURE_SCAN) break;
    }
  } while (cursor !== '0' && failures.length < MAX_FAILURE_SCAN);

  failures.sort((a, b) => {
    const aTime = a.bookmarkSavedAt ?? a.failedAt;
    const bTime = b.bookmarkSavedAt ?? b.failedAt;
    if (aTime !== bTime) return bTime - aTime;
    return b.jobId.localeCompare(a.jobId);
  });
  return failures;
}

function retryClaimKey(failure: ArchiveFailureRecord): string {
  const hash = createHash('sha256')
    .update(failure.ownerPubkey)
    .update('\0')
    .update(failure.url)
    .digest('hex')
    .slice(0, 32);
  return RETRY_CLAIM_PREFIX + hash;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value as number));
}
