/**
 * Delayed retry queue for failed Blossom mirror fanout legs.
 *
 * The fanout in worker.ts runs exactly once per job, so a mirror that
 * happens to be down at archive time (Primal's periodic "db error"
 * outages) used to cost that archive its redundancy on that mirror
 * permanently — the operator alert was the only artifact. Failed legs
 * are parked here instead: a Redis ZSET scored by next-attempt epoch
 * seconds, drained by the worker's retry loop with a widening backoff.
 *
 * The retry loop lives in this package (not Box A) because re-mirroring
 * needs the worker's Blossom signing key.
 */
import type Redis from 'ioredis';

export const MIRROR_RETRY_KEY = 'dm:archive:mirror:retry';

/** Widening gaps between attempts. The 5m/30m steps catch the common
 *  case (a mirror outage that recovers within the hour); the tail keeps
 *  trying across a full-day outage. Exhausting the schedule (~34h)
 *  abandons the copy — safe because the delete path sweeps every
 *  configured operator mirror regardless of which legs succeeded. */
export const MIRROR_RETRY_BACKOFF_SECONDS = [300, 1_800, 7_200, 28_800, 86_400] as const;

export interface MirrorRetryEntry {
  blobHash: string;
  /** Mirror origins that still lack the blob. */
  urls: string[];
  /** Content type for the direct-upload fallback when BUD-04 /mirror fails. */
  contentType?: string;
  /** Backoff-schedule index this entry is waiting on (0 = first retry). */
  attempt: number;
  /** Original job id / page URL, carried for log correlation only. */
  jobId?: string;
  url?: string;
}

/** True when a failed leg's error signature can't heal on its own: every
 *  HTTP status in the message is a non-retryable 4xx. Live example
 *  (2026-07-08): cdn.nostrcheck.me sniffs magic bytes and 400s every
 *  encrypted blob with "file type not detected" — waiting never fixes
 *  that. Transient shapes stay retryable: any 5xx (Primal's "500 db
 *  error" outages), 408/429, or a pure network error carrying no status
 *  at all. Mixed 4xx+5xx also stays retryable — when the signal is
 *  ambiguous, a few wasted attempts beat abandoning a healable leg. */
export function isPermanentMirrorLegError(error?: string): boolean {
  if (!error) return false;
  const statuses = [...error.matchAll(/\b[45]\d\d\b/g)].map((m) => Number(m[0]));
  if (statuses.length === 0) return false;
  return statuses.every((s) => s < 500 && s !== 408 && s !== 429);
}

/** Park an entry for its next attempt. Returns false (and stores
 *  nothing) once the backoff schedule is exhausted. */
export async function scheduleMirrorRetry(
  redis: Redis,
  entry: MirrorRetryEntry,
  nowSeconds: number,
): Promise<boolean> {
  if (entry.urls.length === 0) return false;
  const delay = MIRROR_RETRY_BACKOFF_SECONDS[entry.attempt];
  if (delay === undefined) return false;
  await redis.zadd(MIRROR_RETRY_KEY, nowSeconds + delay, JSON.stringify(entry));
  return true;
}

/** Pop up to `limit` due entries. ZREM is the claim — with several
 *  workers polling the same ZSET, only the one whose ZREM returns 1
 *  processes the entry. Malformed members are dropped on claim. */
export async function claimDueMirrorRetries(
  redis: Redis,
  nowSeconds: number,
  limit: number,
): Promise<MirrorRetryEntry[]> {
  const members = await redis.zrangebyscore(MIRROR_RETRY_KEY, 0, nowSeconds, 'LIMIT', 0, limit);
  const claimed: MirrorRetryEntry[] = [];
  for (const member of members) {
    const removed = await redis.zrem(MIRROR_RETRY_KEY, member);
    if (removed !== 1) continue;
    try {
      const parsed = JSON.parse(member) as MirrorRetryEntry;
      if (
        typeof parsed.blobHash === 'string'
        && Array.isArray(parsed.urls)
        && parsed.urls.every((u) => typeof u === 'string')
        && typeof parsed.attempt === 'number'
      ) {
        claimed.push(parsed);
      }
    } catch {
      // Malformed member: already removed by the ZREM above.
    }
  }
  return claimed;
}

/** Drop every pending retry for a blob. Called from the delete path so
 *  a deleted archive can't be resurrected onto a mirror by a retry that
 *  was scheduled before the delete. */
export async function purgeMirrorRetries(redis: Redis, blobHash: string): Promise<number> {
  const members = await redis.zrange(MIRROR_RETRY_KEY, 0, -1);
  let purged = 0;
  for (const member of members) {
    try {
      if ((JSON.parse(member) as MirrorRetryEntry).blobHash !== blobHash) continue;
    } catch {
      continue;
    }
    purged += await redis.zrem(MIRROR_RETRY_KEY, member);
  }
  return purged;
}
