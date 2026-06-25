import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

export const ARCHIVE_FAILURE_PREFIX = 'dm:archive-failures:';

export type ArchiveFailureReason = 'site-blocked' | 'not-found' | 'timeout' | 'failed';

export interface ArchiveFailureRecord {
  jobId: string;
  ownerPubkey: string;
  url: string;
  reason: ArchiveFailureReason;
  message: string;
  error?: string;
  errorCategory?: string;
  failedAt: number;
  bookmarkSavedAt?: number;
  tier?: string;
  kind?: string;
}

export async function recordArchiveFailure(
  redis: Redis,
  record: Omit<ArchiveFailureRecord, 'reason' | 'message'> & {
    reason?: ArchiveFailureReason;
    message?: string;
  },
): Promise<void> {
  const reason = record.reason ?? classifyArchiveFailureReason(record.error, record.errorCategory);
  const failure: ArchiveFailureRecord = {
    ...record,
    reason,
    message: record.message ?? archiveFailureMessage(reason),
  };
  await redis.hset(
    failureKey(record.ownerPubkey),
    archiveFailureField(record.url),
    JSON.stringify(failure),
  );
}

export async function clearArchiveFailure(redis: Redis, ownerPubkey: string, url: string): Promise<void> {
  await redis.hdel(failureKey(ownerPubkey), archiveFailureField(url));
}

export async function listArchiveFailures(redis: Redis, ownerPubkey: string): Promise<ArchiveFailureRecord[]> {
  const raw = await redis.hgetall(failureKey(ownerPubkey));
  const failures: ArchiveFailureRecord[] = [];
  for (const value of Object.values(raw ?? {})) {
    const parsed = parseArchiveFailureRecord(value, ownerPubkey);
    if (parsed) failures.push(parsed);
  }
  failures.sort((a, b) => {
    const timeline = failureTimelineSeconds(b) - failureTimelineSeconds(a);
    if (timeline !== 0) return timeline;
    return b.jobId.localeCompare(a.jobId);
  });
  return failures;
}

export function parseArchiveFailureRecord(
  raw: string,
  expectedOwnerPubkey?: string,
): ArchiveFailureRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ArchiveFailureRecord>;
    if (!parsed.jobId || !parsed.url || !parsed.ownerPubkey) return null;
    if (expectedOwnerPubkey && parsed.ownerPubkey !== expectedOwnerPubkey) return null;
    const reason = normalizeReason(parsed.reason);
    const failedAt = normalizeUnixSeconds(parsed.failedAt);
    if (!failedAt) return null;
    return {
      jobId: parsed.jobId,
      ownerPubkey: parsed.ownerPubkey,
      url: parsed.url,
      reason,
      message: typeof parsed.message === 'string' && parsed.message.trim()
        ? parsed.message
        : archiveFailureMessage(reason),
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      errorCategory: typeof parsed.errorCategory === 'string' ? parsed.errorCategory : undefined,
      failedAt,
      bookmarkSavedAt: normalizeUnixSeconds(parsed.bookmarkSavedAt),
      tier: typeof parsed.tier === 'string' ? parsed.tier : undefined,
      kind: typeof parsed.kind === 'string' ? parsed.kind : undefined,
    };
  } catch {
    return null;
  }
}

export function classifyArchiveFailureReason(error: unknown, category: unknown): ArchiveFailureReason {
  const text = typeof error === 'string' ? error.toLowerCase() : '';
  if (
    /\b(401|403)\b/.test(text) ||
    text.includes('forbidden') ||
    text.includes('access denied') ||
    text.includes('blocked') ||
    text.includes('captcha') ||
    text.includes('cloudflare')
  ) {
    return 'site-blocked';
  }
  if (/\b404\b/.test(text) || text.includes('not found')) return 'not-found';
  if (text.includes('timeout') || category === 'retryable') return 'timeout';
  return 'failed';
}

export function archiveFailureMessage(reason: ArchiveFailureReason): string {
  if (reason === 'site-blocked') return 'Site blocked the archive capture.';
  if (reason === 'not-found') return 'Page was not found when Deepmarks tried to archive it.';
  if (reason === 'timeout') return 'Archive timed out while loading this page.';
  return 'Archive failed.';
}

export function shouldAlertArchiveFailure(reason: ArchiveFailureReason, error: unknown): boolean {
  if (reason === 'site-blocked' || reason === 'not-found') return false;
  const text = typeof error === 'string' ? error.toLowerCase() : '';
  // A remote HTTP response is a page/user-facing archive outcome, not an
  // operator incident. Keep recording it for the user but do not email.
  if (/\bpage returned http [45]\d\d\b/.test(text)) return false;
  // The archive audit can terminally fail stale jobs after the live queue
  // entry disappeared. That is user-actionable retry state, not one email
  // per lost lifetime archive job.
  if (text.includes('archive job lost before completion')) return false;
  return true;
}

function failureKey(ownerPubkey: string): string {
  return `${ARCHIVE_FAILURE_PREFIX}${ownerPubkey}`;
}

function archiveFailureField(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

function normalizeReason(value: unknown): ArchiveFailureReason {
  return value === 'site-blocked' || value === 'not-found' || value === 'timeout' || value === 'failed'
    ? value
    : 'failed';
}

function normalizeUnixSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function failureTimelineSeconds(record: Pick<ArchiveFailureRecord, 'bookmarkSavedAt' | 'failedAt'>): number {
  return normalizeUnixSeconds(record.bookmarkSavedAt) ?? normalizeUnixSeconds(record.failedAt) ?? 0;
}
