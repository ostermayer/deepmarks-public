import type { Redis } from 'ioredis';

import {
  ARCHIVE_FAILURE_PREFIX,
  isPermanentArchiveFailureReason,
  parseArchiveFailureRecord,
} from './archive-failures.js';

const ARCHIVE_QUEUE = 'dm:archive:queue';
const ARCHIVE_PROCESSING_PREFIX = 'dm:archive:processing:';
const ARCHIVE_ACTIVE_PREFIX = 'dm:archive:active:';
const ARCHIVE_DONE_PREFIX = 'dm:archive:done:';
const ARCHIVE_AUDIT_PREFIX = 'dm:archive:audit:';
const ARCHIVE_WORKER_HEARTBEAT = 'dm:archive:worker-heartbeat';
const ARCHIVE_WORKER_LAST_CALLBACK = 'dm:archive-worker:last-callback';
const ARCHIVE_AUDIT_LAST = 'dm:archive-audit:last';

const DEFAULT_HEARTBEAT_STALE_SECONDS = 300;
const DEFAULT_MAX_OLDEST_QUEUED_SECONDS = 24 * 60 * 60;
const DEFAULT_AUDIT_STALE_SECONDS = 60 * 60;
const DEFAULT_PENDING_SAMPLE_LIMIT = 1_000;
const DEFAULT_TERMINAL_SAMPLE_LIMIT = 1_000;
const RECENT_TERMINAL_WINDOW_SECONDS = 24 * 60 * 60;

export interface ArchiveAuditSummary {
  at: number;
  scanned: number;
  completed: number;
  live: number;
  failed: number;
  stale: number;
  pending: number;
  renotified: number;
  renotifyDeferred: number;
  requeued: number;
  requeueDeferred: number;
  rescued: number;
  rescueDeferred: number;
  waybackMiss: number;
  markedLostFailed: number;
  skippedNonRescuable: number;
  errors: number;
  truncated: boolean;
}

export interface ArchiveFailureReason {
  reason: string;
  count: number;
}

export interface ArchiveSlaSummary {
  terminalSampled: number;
  completed: number;
  failed: number;
  mediaCompleted: number;
  mediaFailed: number;
  webpageCompleted: number;
  webpageFailed: number;
  completedLast24h: number;
  failedLast24h: number;
  webpageCompletedLast24h: number;
  webpageFailedLast24h: number;
  webpageRetryableFailedLast24h: number;
  /** Distinct URLs behind webpageRetryableFailedLast24h — a re-enqueue loop
   *  hammering one URL inflates the job count but not this. */
  webpageRetryableFailedUrlsLast24h: number;
  /** Distinct owners behind those URLs. A broken pipeline fails every
   *  active owner; one user's dead-bookmark import fails exactly one. */
  webpageRetryableFailedOwnersLast24h: number;
  /** Distinct failing URLs NOT belonging to the most-affected owner.
   *  "≥2 owners" alone is trivially met by one stray failure next to a
   *  single user's import (2026-08-22 false page: 123 URLs + 1 URL). */
  webpageRetryableFailedUrlsBeyondTopOwnerLast24h: number;
  webpageTimeoutFailedLast24h: number;
  averageCompletionSeconds: number | null;
  durationSampled: number;
  failureReasons: ArchiveFailureReason[];
}

export interface ArchiveHealthSummary {
  ok: boolean;
  status: string;
  pending: number;
  processing: number;
  activeWorkers: number;
  staleProcessing: number;
  mediaPending: number;
  mediaProcessing: number;
  pendingSampled: number;
  oldestQueuedAt: number | null;
  oldestQueuedAgeSeconds: number | null;
  workerHeartbeatWorkerId: string | null;
  workerHeartbeatAgeSeconds: number | null;
  lastCallbackAt: number | null;
  lastCallbackAgeSeconds: number | null;
  lastAudit: ArchiveAuditSummary | null;
  lastAuditAgeSeconds: number | null;
  sla: ArchiveSlaSummary;
  issues: string[];
  warnings: string[];
}

interface ArchiveHealthOptions {
  nowMs?: number;
  heartbeatStaleSeconds?: number;
  maxOldestQueuedSeconds?: number;
  auditStaleSeconds?: number;
  pendingSampleLimit?: number;
  terminalSampleLimit?: number;
}

interface ParsedArchiveJob {
  enqueuedAt: number | null;
  kind: string;
}

interface ParsedTerminalArchiveJob {
  jobId: string | null;
  status: string;
  completedAt: number | null;
  kind: string;
  contentType: string | null;
  error: string | null;
  errorCategory: string | null;
}

export async function collectArchiveHealth(
  redis: Redis,
  opts: ArchiveHealthOptions = {},
): Promise<ArchiveHealthSummary> {
  const nowMs = opts.nowMs ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const heartbeatStaleSeconds = opts.heartbeatStaleSeconds ?? DEFAULT_HEARTBEAT_STALE_SECONDS;
  const maxOldestQueuedSeconds = opts.maxOldestQueuedSeconds ?? DEFAULT_MAX_OLDEST_QUEUED_SECONDS;
  const auditStaleSeconds = opts.auditStaleSeconds ?? DEFAULT_AUDIT_STALE_SECONDS;
  const pendingSampleLimit = opts.pendingSampleLimit ?? DEFAULT_PENDING_SAMPLE_LIMIT;
  const terminalSampleLimit = opts.terminalSampleLimit ?? DEFAULT_TERMINAL_SAMPLE_LIMIT;

  const [
    pending,
    pendingSample,
    oldestRaw,
    activeKeys,
    processingKeys,
    workerHeartbeatWorkerId,
    workerHeartbeatAgeSeconds,
    lastCallbackRaw,
    lastAudit,
    sla,
  ] = await Promise.all([
    redis.llen(ARCHIVE_QUEUE).catch(() => -1),
    redis.lrange(ARCHIVE_QUEUE, 0, Math.max(0, pendingSampleLimit - 1)).catch(() => []),
    redis.lindex(ARCHIVE_QUEUE, 0).catch(() => null),
    scanKeys(redis, `${ARCHIVE_ACTIVE_PREFIX}*`).catch(() => []),
    scanKeys(redis, `${ARCHIVE_PROCESSING_PREFIX}*`).catch(() => []),
    redis.get(ARCHIVE_WORKER_HEARTBEAT).catch(() => null),
    redisObjectIdleTime(redis, ARCHIVE_WORKER_HEARTBEAT).catch(() => null),
    redis.get(ARCHIVE_WORKER_LAST_CALLBACK).catch(() => null),
    archiveAuditSummary(redis),
    archiveSlaSummary(redis, nowSeconds, terminalSampleLimit),
  ]);

  const activeWorkerIds = new Set(
    activeKeys
      .map((key) => key.slice(ARCHIVE_ACTIVE_PREFIX.length))
      .filter(Boolean),
  );

  let processing = 0;
  let staleProcessing = 0;
  let mediaProcessing = 0;
  for (const key of processingKeys) {
    const items = await redis.lrange(key, 0, -1).catch(() => []);
    processing += items.length;
    mediaProcessing += countMediaJobs(items);
    const workerId = key.slice(ARCHIVE_PROCESSING_PREFIX.length);
    if (items.length > 0 && !activeWorkerIds.has(workerId)) staleProcessing += items.length;
  }

  const oldestQueuedAt = parseArchiveJob(oldestRaw)?.enqueuedAt ?? null;
  const oldestQueuedAgeSeconds = oldestQueuedAt === null ? null : Math.max(0, nowSeconds - oldestQueuedAt);
  const mediaPending = countMediaJobs(pendingSample);
  const lastCallbackAt = parseIntMillis(lastCallbackRaw);
  const lastCallbackAgeSeconds = lastCallbackAt === null ? null : Math.max(0, Math.floor((nowMs - lastCallbackAt) / 1000));
  const lastAuditAgeSeconds = lastAudit === null ? null : Math.max(0, nowSeconds - lastAudit.at);

  const issues: string[] = [];
  const warnings: string[] = [];

  if (pending < 0) {
    issues.push('archive queue depth unreadable');
  }
  if (!workerHeartbeatWorkerId) {
    issues.push('archive worker heartbeat missing');
  } else if (workerHeartbeatAgeSeconds === null || workerHeartbeatAgeSeconds > heartbeatStaleSeconds) {
    issues.push(`archive worker heartbeat stale (${workerHeartbeatAgeSeconds ?? 'unknown'}s)`);
  }
  if (staleProcessing > 0) {
    issues.push(`${staleProcessing} archive processing job${staleProcessing === 1 ? '' : 's'} have no active worker heartbeat`);
  }
  if (oldestQueuedAgeSeconds !== null && oldestQueuedAgeSeconds > maxOldestQueuedSeconds) {
    // A live worker chewing through an old backlog is a capacity problem,
    // not an outage — the uptime probe (503 on any issue) should only page
    // when the worker itself is missing or stale, which the heartbeat
    // checks above already cover. Backlog age with a fresh heartbeat is
    // surfaced as a warning so it stays visible without paging.
    const heartbeatFresh = !!workerHeartbeatWorkerId &&
      workerHeartbeatAgeSeconds !== null &&
      workerHeartbeatAgeSeconds <= heartbeatStaleSeconds;
    if (heartbeatFresh) {
      warnings.push(`oldest archive job has waited ${oldestQueuedAgeSeconds}s (worker alive; backlog draining)`);
    } else {
      issues.push(`oldest archive job has waited ${oldestQueuedAgeSeconds}s`);
    }
  }
  if (!lastAudit) {
    warnings.push('archive audit has not reported yet');
  } else {
    if (lastAuditAgeSeconds !== null && lastAuditAgeSeconds > auditStaleSeconds) {
      issues.push(`archive audit stale (${lastAuditAgeSeconds}s)`);
    }
    if (lastAudit.errors > 0) {
      issues.push(`last archive audit reported ${lastAudit.errors} error${lastAudit.errors === 1 ? '' : 's'}`);
    }
    const unresolvedFailed = Math.max(
      0,
      lastAudit.failed - lastAudit.renotified - lastAudit.renotifyDeferred -
        lastAudit.rescued - lastAudit.rescueDeferred - lastAudit.waybackMiss -
        lastAudit.skippedNonRescuable,
    );
    const unresolvedStale = Math.max(
      0,
      lastAudit.stale - lastAudit.requeued - lastAudit.requeueDeferred -
        lastAudit.rescued - lastAudit.rescueDeferred - lastAudit.waybackMiss -
        lastAudit.markedLostFailed - lastAudit.skippedNonRescuable,
    );
    if (unresolvedFailed > 0 || unresolvedStale > 0) {
      warnings.push(`last archive audit left ${unresolvedFailed} failed and ${unresolvedStale} stale job${unresolvedFailed + unresolvedStale === 1 ? '' : 's'} unresolved`);
    }
  }
  if (pending > pendingSample.length) {
    warnings.push(`media pending count sampled from oldest ${pendingSample.length}/${pending} queued jobs`);
  }
  if (lastCallbackAgeSeconds !== null && lastCallbackAgeSeconds > 24 * 60 * 60) {
    warnings.push(`last archive callback ${lastCallbackAgeSeconds}s ago`);
  }
  const recentWebpageTerminal = sla.webpageCompletedLast24h + sla.webpageFailedLast24h;
  // Spike = MANY DISTINCT URLs failing retryably ACROSS OWNERS — the
  // systemic signal (worker/render pipeline broken). Counting raw jobs let
  // one user's re-enqueue loop (2026-08-21: 92 jobs for one dead URL while
  // Wayback was down) hold the uptime pager critical; distinct URLs stay
  // one-owner-shaped when a user imports a graveyard of dead bookmarks; and
  // "≥2 owners" alone was trivially met by ONE stray failure from a second
  // owner next to that import (2026-08-22: 123+1 paged again). Systemic
  // means real spread: at least 10 distinct failing URLs OUTSIDE the
  // most-affected owner. Anything one-owner-dominated is a warning, not an
  // availability issue — the uptime probe pages on `issues` only.
  const retryableSpike =
    recentWebpageTerminal >= 20 &&
    sla.webpageRetryableFailedUrlsLast24h >= 25 &&
    sla.webpageRetryableFailedLast24h / recentWebpageTerminal >= 0.5;
  if (retryableSpike) {
    const detail =
      `${sla.webpageRetryableFailedLast24h}/${recentWebpageTerminal} recent jobs, ` +
      `${sla.webpageRetryableFailedUrlsLast24h} distinct URLs, ` +
      `${sla.webpageRetryableFailedOwnersLast24h} owner${sla.webpageRetryableFailedOwnersLast24h === 1 ? '' : 's'}, ` +
      `${sla.webpageRetryableFailedUrlsBeyondTopOwnerLast24h} beyond top owner`;
    if (sla.webpageRetryableFailedUrlsBeyondTopOwnerLast24h >= 10) {
      issues.push(`archive webpage retryable failure spike (${detail})`);
    } else {
      warnings.push(`archive webpage retryable failures concentrated in one owner (${detail})`);
    }
  }

  const ok = issues.length === 0;
  return {
    ok,
    status: ok ? archiveOkStatus(pending, processing, workerHeartbeatAgeSeconds) : issues[0]!,
    pending,
    processing,
    activeWorkers: activeWorkerIds.size,
    staleProcessing,
    mediaPending,
    mediaProcessing,
    pendingSampled: pendingSample.length,
    oldestQueuedAt,
    oldestQueuedAgeSeconds,
    workerHeartbeatWorkerId,
    workerHeartbeatAgeSeconds,
    lastCallbackAt,
    lastCallbackAgeSeconds,
    lastAudit,
    lastAuditAgeSeconds,
    sla,
    issues,
    warnings,
  };
}

export async function archiveAuditSummary(redis: Redis): Promise<ArchiveAuditSummary | null> {
  try {
    const raw = await redis.get(ARCHIVE_AUDIT_LAST);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ArchiveAuditSummary>;
    if (typeof parsed.at !== 'number' || typeof parsed.scanned !== 'number') return null;
    return {
      at: parsed.at,
      scanned: parsed.scanned,
      completed: parsed.completed ?? 0,
      live: parsed.live ?? 0,
      failed: parsed.failed ?? 0,
      stale: parsed.stale ?? 0,
      pending: parsed.pending ?? 0,
      renotified: parsed.renotified ?? 0,
      renotifyDeferred: parsed.renotifyDeferred ?? 0,
      requeued: parsed.requeued ?? 0,
      requeueDeferred: parsed.requeueDeferred ?? 0,
      rescued: parsed.rescued ?? 0,
      rescueDeferred: parsed.rescueDeferred ?? 0,
      waybackMiss: parsed.waybackMiss ?? 0,
      markedLostFailed: parsed.markedLostFailed ?? 0,
      skippedNonRescuable: parsed.skippedNonRescuable ?? 0,
      errors: parsed.errors ?? 0,
      truncated: parsed.truncated === true,
    };
  } catch {
    return null;
  }
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  let cursor = '0';
  const keys: string[] = [];
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

async function scanKeysLimited(redis: Redis, pattern: string, limit: number): Promise<string[]> {
  let cursor = '0';
  const keys: string[] = [];
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0' && keys.length < limit);
  return keys.slice(0, limit);
}

async function redisObjectIdleTime(redis: Redis, key: string): Promise<number | null> {
  const client = redis as unknown as {
    object?: (subcommand: string, key: string) => Promise<number | string | null>;
  };
  if (!client.object) return null;
  const raw = await client.object('IDLETIME', key);
  if (raw === null) return null;
  const n = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function archiveOkStatus(pending: number, processing: number, heartbeatAgeSeconds: number | null): string {
  const age = heartbeatAgeSeconds === null ? 'unknown' : `${heartbeatAgeSeconds}s`;
  return `pending ${Math.max(0, pending)}, processing ${processing}, heartbeat ${age}`;
}

function countMediaJobs(items: string[]): number {
  let count = 0;
  for (const raw of items) {
    const kind = parseArchiveJob(raw)?.kind;
    if (kind === 'media' || kind === 'video' || kind === 'youtube' || kind === 'file') count++;
  }
  return count;
}

async function archiveSlaSummary(
  redis: Redis,
  nowSeconds: number,
  terminalSampleLimit: number,
): Promise<ArchiveSlaSummary> {
  const keys = await scanKeysLimited(redis, `${ARCHIVE_DONE_PREFIX}*`, terminalSampleLimit).catch(() => []);
  const reasonCounts = new Map<string, number>();
  const durations: number[] = [];
  let completed = 0;
  let failed = 0;
  let mediaCompleted = 0;
  let mediaFailed = 0;
  let webpageCompleted = 0;
  let webpageFailed = 0;
  let completedLast24h = 0;
  let failedLast24h = 0;
  let webpageCompletedLast24h = 0;
  let webpageFailedLast24h = 0;
  let webpageRetryableFailedLast24h = 0;
  let webpageTimeoutFailedLast24h = 0;

  await Promise.all(keys.map(async (key) => {
    const raw = await redis.get(key).catch(() => null);
    const parsed = parseTerminalArchiveJob(raw, key);
    if (!parsed) return;
    const media = isMediaTerminalJob(parsed, key);
    const recent = parsed.completedAt !== null
      && nowSeconds - parsed.completedAt <= RECENT_TERMINAL_WINDOW_SECONDS;

    if (parsed.status === 'ok') {
      completed += 1;
      if (media) mediaCompleted += 1;
      else webpageCompleted += 1;
      if (recent) {
        completedLast24h += 1;
        if (!media) webpageCompletedLast24h += 1;
      }
      const duration = await terminalDurationSeconds(redis, parsed, key);
      if (duration !== null) durations.push(duration);
      return;
    }

    failed += 1;
    if (media) mediaFailed += 1;
    else webpageFailed += 1;
    const reason = classifyFailureReason(parsed);
    if (recent) {
      failedLast24h += 1;
      if (!media) {
        webpageFailedLast24h += 1;
        if (parsed.errorCategory === 'retryable') webpageRetryableFailedLast24h += 1;
        if (reason === 'timeout' || reason.endsWith(':timeout')) webpageTimeoutFailedLast24h += 1;
      }
    }
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }));

  const averageCompletionSeconds = durations.length === 0
    ? null
    : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);

  return {
    terminalSampled: keys.length,
    completed,
    failed,
    mediaCompleted,
    mediaFailed,
    webpageCompleted,
    webpageFailed,
    completedLast24h,
    failedLast24h,
    webpageCompletedLast24h,
    webpageFailedLast24h,
    webpageRetryableFailedLast24h,
    ...await countRecentRetryableFailureUrls(redis, nowSeconds)
      .then(({ urls, owners, urlsBeyondTopOwner }) => ({
        webpageRetryableFailedUrlsLast24h: urls,
        webpageRetryableFailedOwnersLast24h: owners,
        webpageRetryableFailedUrlsBeyondTopOwnerLast24h: urlsBeyondTopOwner,
      }))
      .catch(() => ({
        webpageRetryableFailedUrlsLast24h: 0,
        webpageRetryableFailedOwnersLast24h: 0,
        webpageRetryableFailedUrlsBeyondTopOwnerLast24h: 0,
      })),
    webpageTimeoutFailedLast24h,
    averageCompletionSeconds,
    durationSampled: durations.length,
    failureReasons: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .slice(0, 8),
  };
}

/** Distinct URLs (and owners) whose last terminal failure was retryable
 *  (non-permanent) and within the 24h window. Sourced from the per-owner
 *  failure hashes — one entry per owner+URL by construction — because
 *  terminal done-records carry no url, and counting jobs let a re-enqueue
 *  loop on a handful of dead URLs read as a pipeline-wide spike
 *  (2026-08-21). Bounded scan so a huge failure history cannot stall the
 *  health endpoint. */
async function countRecentRetryableFailureUrls(
  redis: Redis,
  nowSeconds: number,
): Promise<{ urls: number; owners: number; urlsBeyondTopOwner: number }> {
  const urls = new Set<string>();
  const owners = new Set<string>();
  // Distinct recent-failing URLs per owner (fields in an owner's failure
  // hash are unique per URL by construction).
  const perOwner = new Map<string, number>();
  const summarize = (): { urls: number; owners: number; urlsBeyondTopOwner: number } => {
    let top = 0;
    for (const count of perOwner.values()) top = Math.max(top, count);
    return {
      urls: urls.size,
      owners: owners.size,
      urlsBeyondTopOwner: Math.max(0, urls.size - top),
    };
  };
  let cursor = '0';
  let ownersScanned = 0;
  do {
    // COUNT 5000: unlike the done-record scans above, this one cannot
    // early-exit — matches are a handful of keys spread across the whole
    // keyspace (~870k keys), and COUNT 100 turned the walk into ~9k Redis
    // round-trips (+1.5s on every /health/archive probe).
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${ARCHIVE_FAILURE_PREFIX}*`,
      'COUNT',
      5000,
    );
    cursor = next;
    for (const key of keys) {
      const owner = key.slice(ARCHIVE_FAILURE_PREFIX.length);
      const raw = await redis.hgetall(key).catch(() => ({} as Record<string, string>));
      for (const value of Object.values(raw ?? {})) {
        const failure = parseArchiveFailureRecord(value, owner);
        if (!failure || isPermanentArchiveFailureReason(failure.reason)) continue;
        if (nowSeconds - failure.failedAt > RECENT_TERMINAL_WINDOW_SECONDS) continue;
        urls.add(failure.url);
        owners.add(owner);
        perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
        if (urls.size >= 1_000) return summarize();
      }
      ownersScanned += 1;
      if (ownersScanned >= 2_000) return summarize();
    }
  } while (cursor !== '0');
  return summarize();
}

async function terminalDurationSeconds(
  redis: Redis,
  record: ParsedTerminalArchiveJob,
  key: string,
): Promise<number | null> {
  if (record.completedAt === null) return null;
  const jobId = record.jobId ?? key.slice(ARCHIVE_DONE_PREFIX.length);
  if (!jobId) return null;
  const items = await redis.lrange(`${ARCHIVE_AUDIT_PREFIX}${jobId}`, 0, -1).catch(() => []);
  let firstAtMs: number | null = null;
  for (const raw of items) {
    const at = parseAuditAt(raw);
    if (at === null) continue;
    firstAtMs = firstAtMs === null ? at : Math.min(firstAtMs, at);
  }
  if (firstAtMs === null) return null;
  const durationSeconds = Math.round((record.completedAt * 1000 - firstAtMs) / 1000);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 14 * 24 * 60 * 60) {
    return null;
  }
  return durationSeconds;
}

function parseAuditAt(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { at?: unknown };
    return typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : null;
  } catch {
    return null;
  }
}

function parseTerminalArchiveJob(raw: string | null, key: string): ParsedTerminalArchiveJob | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      jobId?: unknown;
      status?: unknown;
      completedAt?: unknown;
      kind?: unknown;
      contentType?: unknown;
      error?: unknown;
      errorCategory?: unknown;
    };
    return {
      jobId: typeof parsed.jobId === 'string' ? parsed.jobId : key.slice(ARCHIVE_DONE_PREFIX.length),
      status: typeof parsed.status === 'string' ? parsed.status.toLowerCase() : 'unknown',
      completedAt: typeof parsed.completedAt === 'number' && Number.isFinite(parsed.completedAt)
        ? parsed.completedAt
        : null,
      kind: typeof parsed.kind === 'string' ? parsed.kind.toLowerCase() : '',
      contentType: typeof parsed.contentType === 'string' ? parsed.contentType.toLowerCase() : null,
      error: typeof parsed.error === 'string' ? parsed.error : null,
      errorCategory: typeof parsed.errorCategory === 'string' ? parsed.errorCategory.toLowerCase() : null,
    };
  } catch {
    return null;
  }
}

function isMediaTerminalJob(record: ParsedTerminalArchiveJob, key: string): boolean {
  if (key.startsWith(`${ARCHIVE_DONE_PREFIX}media:`)) return true;
  if (record.kind === 'media' || record.kind === 'video' || record.kind === 'youtube' || record.kind === 'file') return true;
  return !!record.contentType && /^(audio|video|image)\//.test(record.contentType);
}

function classifyFailureReason(record: ParsedTerminalArchiveJob): string {
  const error = (record.error ?? '').toLowerCase();
  let detail = 'failed';
  if (/unsupported|no suitable|not supported/.test(error)) detail = 'unsupported-url';
  else if (/timeout|timed out|deadline/.test(error)) detail = 'timeout';
  else if (/\b403\b|forbidden/.test(error)) detail = 'forbidden';
  else if (/\b404\b|not found/.test(error)) detail = 'not-found';
  else if (/too large|max media|exceeds/.test(error)) detail = 'too-large';
  else if (/yt-dlp|extractor|download.*media/.test(error)) detail = 'media-extractor';
  else if (/ffmpeg|remux|transcod/.test(error)) detail = 'media-transcode';
  else if (/dns|enotfound|eai_again/.test(error)) detail = 'dns';
  else if (/ssrf|private ip|blocked host/.test(error)) detail = 'blocked-host';
  const category = record.errorCategory && record.errorCategory !== 'unknown'
    ? record.errorCategory
    : null;
  return category && detail !== 'failed' ? `${category}:${detail}` : (category ?? detail);
}

function parseArchiveJob(raw: string | null): ParsedArchiveJob | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { enqueuedAt?: unknown; kind?: unknown };
    return {
      enqueuedAt: typeof parsed.enqueuedAt === 'number' && Number.isFinite(parsed.enqueuedAt)
        ? parsed.enqueuedAt
        : null,
      kind: typeof parsed.kind === 'string' ? parsed.kind.toLowerCase() : 'webpage',
    };
  } catch {
    return null;
  }
}

function parseIntMillis(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
