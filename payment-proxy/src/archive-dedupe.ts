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
