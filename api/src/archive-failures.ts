import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

export const ARCHIVE_FAILURE_PREFIX = 'dm:archive-failures:';

export type ArchiveFailureReason = 'site-blocked' | 'not-found' | 'too-large' | 'timeout' | 'failed';

export type ArchiveRescueStatus = 'skipped' | 'no-candidate' | 'candidate-found' | 'enqueued' | 'failed';

export interface ArchiveFailureRescueSummary {
  status: ArchiveRescueStatus;
  checkedAt: number;
  skippedReason?: string;
  candidates?: Array<{
    url: string;
    source: string;
    reason: string;
    confidence: number;
  }>;
  verifiedCandidates?: Array<{
    url: string;
    source: string;
    reason: string;
    confidence: number;
    status: number;
    finalUrl?: string;
    contentType?: string;
  }>;
  enqueuedJobId?: string;
  enqueuedUrl?: string;
  searchQueries?: string[];
  error?: string;
}

export interface ArchiveFailureRecord {
  jobId: string;
  ownerPubkey: string;
  url: string;
  eventId?: string;
  reason: ArchiveFailureReason;
  message: string;
  error?: string;
  errorCategory?: string;
  failedAt: number;
  bookmarkSavedAt?: number;
  tier?: string;
  kind?: string;
  mirrorUrls?: string[];
  rescue?: ArchiveFailureRescueSummary;
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

export async function updateArchiveFailureRescue(
  redis: Redis,
  record: ArchiveFailureRecord,
  rescue: ArchiveFailureRescueSummary,
): Promise<void> {
  const key = failureKey(record.ownerPubkey);
  const field = archiveFailureField(record.url);
  const existingRaw = await redis.hget(key, field).catch(() => null);
  const existing = existingRaw ? parseArchiveFailureRecord(existingRaw, record.ownerPubkey) : null;
  await redis.hset(key, field, JSON.stringify({
    ...(existing ?? record),
    rescue,
  }));
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
      eventId: typeof parsed.eventId === 'string' ? parsed.eventId : undefined,
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
      mirrorUrls: normalizeStringArray(parsed.mirrorUrls, 8, 500),
      rescue: normalizeRescueSummary(parsed.rescue),
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
    text.includes('cloudflare') ||
    isRemotePageNetworkFailure(text)
  ) {
    return 'site-blocked';
  }
  if (/\b404\b/.test(text) || text.includes('not found')) return 'not-found';
  if (
    text.includes('file_too_large') ||
    text.includes('too large') ||
    (/exceeds \d+/.test(text) && (text.includes('singlefile output') || text.includes('file ')))
  ) {
    return 'too-large';
  }
  if (text.includes('timeout') || category === 'retryable') return 'timeout';
  return 'failed';
}

export function archiveFailureMessage(reason: ArchiveFailureReason): string {
  if (reason === 'site-blocked') return 'Site blocked the archive capture.';
  if (reason === 'not-found') return 'Page was not found when Deepmarks tried to archive it.';
  if (reason === 'too-large') return 'Page was too large for the archive size limit.';
  if (reason === 'timeout') return 'Archive timed out while loading this page.';
  return 'Archive failed.';
}

export function shouldAlertArchiveFailure(
  reason: ArchiveFailureReason,
  error: unknown,
  kind?: string,
): boolean {
  if (reason === 'site-blocked' || reason === 'not-found' || reason === 'too-large') return false;
  // Media archiving (yt-dlp etc.) is best-effort: most tweets/links carry
  // no downloadable media, so a terminal media failure is an expected
  // content outcome, not an operator incident. Systemic media trouble
  // (e.g. yt-dlp broken on the worker) is caught by aggregate
  // archive-health, which alerts independently of these per-job callbacks.
  if (kind === 'media' || kind === 'video' || kind === 'youtube') return false;
  const text = typeof error === 'string' ? error.toLowerCase() : '';
  // Content genuinely isn't there to capture (yt-dlp "no video", an
  // unsupported URL, no playable formats) — belt-and-suspenders for media
  // failures whose job kind wasn't threaded through.
  if (isMediaContentUnavailable(text)) return false;
  // A remote HTTP response is a page/user-facing archive outcome, not an
  // operator incident. Keep recording it for the user but do not email.
  if (/\bpage returned http [45]\d\d\b/.test(text)) return false;
  // A single page that never reaches Playwright's readiness condition is
  // also a page outcome. Aggregate archive health catches systemic worker
  // trouble; the per-job callback should not page the operator for every
  // hostile or slow publisher URL.
  if (isRemotePageTimeout(text)) return false;
  // Browser-level network/TLS failures are usually one publisher URL or one
  // stale host, not an operator incident. Keep them visible to the user.
  if (isRemotePageNetworkFailure(text)) return false;
  // The archive audit can terminally fail stale jobs after the live queue
  // entry disappeared. That is user-actionable retry state, not one email
  // per lost lifetime archive job.
  if (text.includes('archive job lost before completion')) return false;
  return true;
}

/** yt-dlp / media-extractor errors that mean the URL simply has no
 *  archivable media — an expected best-effort outcome, never an operator
 *  incident. */
function isMediaContentUnavailable(text: string): boolean {
  return (
    text.includes('no video could be found') ||
    text.includes('no video in this') ||
    text.includes('there is no video') ||
    text.includes('no media found') ||
    text.includes('unsupported url') ||
    text.includes('no playable') ||
    text.includes('requested format is not available') ||
    text.includes('unable to extract')
  );
}

function isRemotePageTimeout(text: string): boolean {
  return (
    /page\.goto:\s*timeout/.test(text) ||
    text.includes('render exceeded total timeout')
  );
}

function isRemotePageNetworkFailure(text: string): boolean {
  return /page\.goto:\s*net::err_[a-z0-9_]+/.test(text);
}

function failureKey(ownerPubkey: string): string {
  return `${ARCHIVE_FAILURE_PREFIX}${ownerPubkey}`;
}

function archiveFailureField(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

function normalizeReason(value: unknown): ArchiveFailureReason {
  return value === 'site-blocked' || value === 'not-found' || value === 'too-large' || value === 'timeout' || value === 'failed'
    ? value
    : 'failed';
}

function normalizeUnixSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeStringArray(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, maxLength))
    .slice(0, maxItems);
  return out.length > 0 ? out : undefined;
}

function normalizeRescueSummary(value: unknown): ArchiveFailureRescueSummary | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<ArchiveFailureRescueSummary>;
  const status = normalizeRescueStatus(raw.status);
  const checkedAt = normalizeUnixSeconds(raw.checkedAt);
  if (!status || !checkedAt) return undefined;
  return {
    status,
    checkedAt,
    skippedReason: typeof raw.skippedReason === 'string' ? raw.skippedReason : undefined,
    candidates: normalizeRescueCandidates(raw.candidates),
    verifiedCandidates: normalizeVerifiedRescueCandidates(raw.verifiedCandidates),
    enqueuedJobId: typeof raw.enqueuedJobId === 'string' ? raw.enqueuedJobId : undefined,
    enqueuedUrl: typeof raw.enqueuedUrl === 'string' ? raw.enqueuedUrl : undefined,
    searchQueries: normalizeStringArray(raw.searchQueries, 5, 200),
    error: typeof raw.error === 'string' ? raw.error : undefined,
  };
}

function normalizeRescueStatus(value: unknown): ArchiveRescueStatus | undefined {
  return value === 'skipped' || value === 'no-candidate' || value === 'candidate-found' || value === 'enqueued' || value === 'failed'
    ? value
    : undefined;
}

function normalizeRescueCandidates(
  value: unknown,
): ArchiveFailureRescueSummary['candidates'] {
  if (!Array.isArray(value)) return undefined;
  const out: NonNullable<ArchiveFailureRescueSummary['candidates']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.url !== 'string' || typeof raw.source !== 'string') continue;
    out.push({
      url: raw.url.slice(0, 2_000),
      source: raw.source.slice(0, 80),
      reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 240) : '',
      confidence: normalizeConfidence(raw.confidence),
    });
    if (out.length >= 12) break;
  }
  return out.length > 0 ? out : undefined;
}

function normalizeVerifiedRescueCandidates(
  value: unknown,
): ArchiveFailureRescueSummary['verifiedCandidates'] {
  if (!Array.isArray(value)) return undefined;
  const out: NonNullable<ArchiveFailureRescueSummary['verifiedCandidates']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.url !== 'string' || typeof raw.source !== 'string' || typeof raw.status !== 'number') continue;
    out.push({
      url: raw.url.slice(0, 2_000),
      source: raw.source.slice(0, 80),
      reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 240) : '',
      confidence: normalizeConfidence(raw.confidence),
      status: raw.status,
      finalUrl: typeof raw.finalUrl === 'string' ? raw.finalUrl.slice(0, 2_000) : undefined,
      contentType: typeof raw.contentType === 'string' ? raw.contentType.slice(0, 200) : undefined,
    });
    if (out.length >= 8) break;
  }
  return out.length > 0 ? out : undefined;
}

function normalizeConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

function failureTimelineSeconds(record: Pick<ArchiveFailureRecord, 'bookmarkSavedAt' | 'failedAt'>): number {
  return normalizeUnixSeconds(record.bookmarkSavedAt) ?? normalizeUnixSeconds(record.failedAt) ?? 0;
}
