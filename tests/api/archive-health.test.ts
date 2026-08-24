import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';

import { collectArchiveHealth } from '@src/archive-health.js';

class FakeRedis {
  kv = new Map<string, string>();
  lists = new Map<string, string[]>();
  hashes = new Map<string, Map<string, string>>();
  idle = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  setHashField(key: string, field: string, value: string): void {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    hash.set(field, value);
    this.hashes.set(key, hash);
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.kv.set(key, value);
    return 'OK';
  }

  async llen(key: string): Promise<number> {
    return this.lists.get(key)?.length ?? 0;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const normalizedStop = stop < 0 ? list.length + stop : stop;
    return list.slice(start, normalizedStop + 1);
  }

  async lindex(key: string, index: number): Promise<string | null> {
    return this.lists.get(key)?.[index] ?? null;
  }

  async scan(_cursor: string, _match: string, pattern: string): Promise<[string, string[]]> {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    const keys = [...this.kv.keys(), ...this.lists.keys(), ...this.hashes.keys()]
      .filter((key) => key.startsWith(prefix));
    return ['0', keys];
  }

  async object(subcommand: string, key: string): Promise<number | null> {
    if (subcommand !== 'IDLETIME') return null;
    return this.idle.get(key) ?? null;
  }

  pushList(key: string, ...items: string[]): void {
    this.lists.set(key, [...(this.lists.get(key) ?? []), ...items]);
  }
}

const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

function archiveJob(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jobId: 'job-1',
    paymentHash: 'job-1',
    ownerPubkey: 'a'.repeat(64),
    url: 'https://example.com',
    tier: 'private',
    archiveKey: null,
    attempts: 0,
    enqueuedAt: NOW_SECONDS - 60,
    kind: 'webpage',
    ...overrides,
  });
}

async function healthyRedis(): Promise<FakeRedis> {
  const redis = new FakeRedis();
  await redis.set('dm:archive:worker-heartbeat', 'w-1');
  redis.idle.set('dm:archive:worker-heartbeat', 12);
  await redis.set('dm:archive-audit:last', JSON.stringify({
    at: NOW_SECONDS - 30,
    scanned: 10,
    completed: 10,
    live: 10,
    failed: 0,
    stale: 0,
    pending: 0,
    renotified: 0,
    rescued: 0,
    waybackMiss: 0,
    markedLostFailed: 0,
    skippedNonRescuable: 0,
    errors: 0,
    truncated: false,
  }));
  return redis;
}

describe('collectArchiveHealth', () => {
  it('reports healthy idle archive infrastructure', async () => {
    const redis = await healthyRedis();

    const health = await collectArchiveHealth(redis as unknown as Redis, { nowMs: NOW_MS });

    expect(health.ok).toBe(true);
    expect(health.pending).toBe(0);
    expect(health.processing).toBe(0);
    expect(health.workerHeartbeatAgeSeconds).toBe(12);
    expect(health.sla.terminalSampled).toBe(0);
    expect(health.issues).toEqual([]);
  });

  it('warns without failing when a queued job is old but the worker heartbeat is fresh', async () => {
    const redis = await healthyRedis();
    redis.pushList('dm:archive:queue', archiveJob({ enqueuedAt: NOW_SECONDS - 90_000 }));

    const health = await collectArchiveHealth(redis as unknown as Redis, { nowMs: NOW_MS });

    expect(health.ok).toBe(true);
    expect(health.pending).toBe(1);
    expect(health.oldestQueuedAgeSeconds).toBe(90_000);
    expect(health.issues).toEqual([]);
    expect(health.warnings.join('\n')).toMatch(/oldest archive job/);
  });

  it('flags a queued job older than the alert threshold when the worker heartbeat is stale', async () => {
    const redis = await healthyRedis();
    redis.idle.set('dm:archive:worker-heartbeat', 301);
    redis.pushList('dm:archive:queue', archiveJob({ enqueuedAt: NOW_SECONDS - 90_000 }));

    const health = await collectArchiveHealth(redis as unknown as Redis, { nowMs: NOW_MS });

    expect(health.ok).toBe(false);
    expect(health.pending).toBe(1);
    expect(health.oldestQueuedAgeSeconds).toBe(90_000);
    expect(health.issues.join('\n')).toMatch(/oldest archive job/);
    expect(health.issues.join('\n')).toMatch(/heartbeat stale/);
  });

  it('flags processing jobs left behind by a worker with no active heartbeat', async () => {
    const redis = await healthyRedis();
    redis.pushList('dm:archive:processing:w-dead', archiveJob());

    const health = await collectArchiveHealth(redis as unknown as Redis, { nowMs: NOW_MS });

    expect(health.ok).toBe(false);
    expect(health.processing).toBe(1);
    expect(health.staleProcessing).toBe(1);
    expect(health.issues.join('\n')).toMatch(/no active worker heartbeat/);
  });

  it('does not treat a live worker processing list as stale', async () => {
    const redis = await healthyRedis();
    redis.pushList('dm:archive:processing:w-live', archiveJob({ kind: 'media' }));
    await redis.set('dm:archive:active:w-live', archiveJob({ kind: 'media' }));

    const health = await collectArchiveHealth(redis as unknown as Redis, { nowMs: NOW_MS });

    expect(health.ok).toBe(true);
    expect(health.processing).toBe(1);
    expect(health.mediaProcessing).toBe(1);
    expect(health.staleProcessing).toBe(0);
  });

  it('summarizes terminal archive SLA metrics and failure reasons', async () => {
    const redis = await healthyRedis();
    await redis.set('dm:archive:done:media:ok-1', JSON.stringify({
      jobId: 'media:ok-1',
      status: 'ok',
      kind: 'media',
      completedAt: NOW_SECONDS - 10,
      contentType: 'video/mp4',
    }));
    redis.pushList(
      'dm:archive:audit:media:ok-1',
      JSON.stringify({ state: 'completed', at: (NOW_SECONDS - 10) * 1000 }),
      JSON.stringify({ state: 'started', at: (NOW_SECONDS - 70) * 1000 }),
    );
    await redis.set('dm:archive:done:lifetime:failed-1', JSON.stringify({
      jobId: 'lifetime:failed-1',
      status: 'failed',
      completedAt: NOW_SECONDS - 20,
      errorCategory: 'permanent',
      error: 'yt-dlp extractor failed',
    }));

    const health = await collectArchiveHealth(redis as unknown as Redis, { nowMs: NOW_MS });

    expect(health.sla.terminalSampled).toBe(2);
    expect(health.sla.completed).toBe(1);
    expect(health.sla.failed).toBe(1);
    expect(health.sla.mediaCompleted).toBe(1);
    expect(health.sla.webpageFailed).toBe(1);
    expect(health.sla.completedLast24h).toBe(1);
    expect(health.sla.failedLast24h).toBe(1);
    expect(health.sla.webpageCompletedLast24h).toBe(0);
    expect(health.sla.webpageFailedLast24h).toBe(1);
    expect(health.sla.webpageRetryableFailedLast24h).toBe(0);
    expect(health.sla.averageCompletionSeconds).toBe(60);
    expect(health.sla.failureReasons).toEqual([
      { reason: 'permanent:media-extractor', count: 1 },
    ]);
  });

  it('flags a webpage retryable failure spike across many distinct URLs and owners', async () => {
    const redis = await healthyRedis();
    const owners = ['c'.repeat(64), 'd'.repeat(64)];
    for (let i = 0; i < 26; i += 1) {
      const owner = owners[i % owners.length]!;
      await redis.set(`dm:archive:done:lifetime:timeout-${i}`, JSON.stringify({
        jobId: `lifetime:timeout-${i}`,
        status: 'failed',
        kind: 'webpage',
        completedAt: NOW_SECONDS - 60,
        errorCategory: 'retryable',
        error: 'page.goto: Timeout 30000ms exceeded',
      }));
      redis.setHashField(`dm:archive-failures:${owner}`, `url-${i}`, JSON.stringify({
        jobId: `lifetime:timeout-${i}`,
        ownerPubkey: owner,
        url: `https://example.com/page-${i}`,
        reason: 'timeout',
        failedAt: NOW_SECONDS - 60,
      }));
    }
    for (let i = 0; i < 8; i += 1) {
      await redis.set(`dm:archive:done:lifetime:ok-${i}`, JSON.stringify({
        jobId: `lifetime:ok-${i}`,
        status: 'ok',
        kind: 'webpage',
        completedAt: NOW_SECONDS - 60,
      }));
    }

    const health = await collectArchiveHealth(redis as unknown as Redis, { nowMs: NOW_MS });

    expect(health.ok).toBe(false);
    expect(health.sla.webpageRetryableFailedLast24h).toBe(26);
    expect(health.sla.webpageRetryableFailedUrlsLast24h).toBe(26);
    expect(health.sla.webpageRetryableFailedOwnersLast24h).toBe(2);
    expect(health.sla.webpageRetryableFailedUrlsBeyondTopOwnerLast24h).toBe(13);
    expect(health.sla.webpageTimeoutFailedLast24h).toBe(26);
    expect(health.issues.join('\n')).toMatch(/retryable failure spike/);
  });

  it('does not page when a second owner contributes only a stray failure', async () => {
    // 2026-08-22 false page: 123 distinct failing URLs from the importing
    // owner plus ONE from someone else satisfied "≥2 owners". Systemic
    // means spread beyond the top owner (≥10 distinct URLs).
    const redis = await healthyRedis();
    const importer = 'c'.repeat(64);
    const stray = 'd'.repeat(64);
    for (let i = 0; i < 31; i += 1) {
      await redis.set(`dm:archive:done:lifetime:mix-${i}`, JSON.stringify({
        jobId: `lifetime:mix-${i}`,
        status: 'failed',
        kind: 'webpage',
        completedAt: NOW_SECONDS - 60,
        errorCategory: 'retryable',
        error: 'page.goto: Timeout 30000ms exceeded',
      }));
    }
    for (let i = 0; i < 30; i += 1) {
      redis.setHashField(`dm:archive-failures:${importer}`, `url-${i}`, JSON.stringify({
        jobId: `lifetime:mix-${i}`,
        ownerPubkey: importer,
        url: `https://example.com/import-${i}`,
        reason: 'timeout',
        failedAt: NOW_SECONDS - 60,
      }));
    }
    redis.setHashField(`dm:archive-failures:${stray}`, 'url-stray', JSON.stringify({
      jobId: 'lifetime:mix-stray',
      ownerPubkey: stray,
      url: 'https://example.com/stray',
      reason: 'failed',
      failedAt: NOW_SECONDS - 60,
    }));

    const health = await collectArchiveHealth(redis as unknown as Redis, { nowMs: NOW_MS });

    expect(health.ok).toBe(true);
    expect(health.sla.webpageRetryableFailedOwnersLast24h).toBe(2);
    expect(health.sla.webpageRetryableFailedUrlsBeyondTopOwnerLast24h).toBe(1);
    expect(health.issues.join('\n')).not.toMatch(/retryable failure spike/);
    expect(health.warnings.join('\n')).toMatch(/concentrated in one owner/);
  });

  it('downgrades a single-owner mass failure to a warning instead of paging', async () => {
    // 2026-08-21: one user's import of dead bookmarks (Wayback down) put
    // 175 distinct failing URLs in the window — all one owner. That is a
    // content problem, not an availability problem: it must not 503 the
    // uptime probe.
    const redis = await healthyRedis();
    const owner = 'c'.repeat(64);
    for (let i = 0; i < 26; i += 1) {
      await redis.set(`dm:archive:done:lifetime:timeout-${i}`, JSON.stringify({
        jobId: `lifetime:timeout-${i}`,
        status: 'failed',
        kind: 'webpage',
        completedAt: NOW_SECONDS - 60,
        errorCategory: 'retryable',
        error: 'page.goto: Timeout 30000ms exceeded',
      }));
      redis.setHashField(`dm:archive-failures:${owner}`, `url-${i}`, JSON.stringify({
        jobId: `lifetime:timeout-${i}`,
        ownerPubkey: owner,
        url: `https://example.com/page-${i}`,
        reason: 'timeout',
        failedAt: NOW_SECONDS - 60,
      }));
    }

    const health = await collectArchiveHealth(redis as unknown as Redis, { nowMs: NOW_MS });

    expect(health.ok).toBe(true);
    expect(health.sla.webpageRetryableFailedOwnersLast24h).toBe(1);
    expect(health.sla.webpageRetryableFailedUrlsBeyondTopOwnerLast24h).toBe(0);
    expect(health.issues.join('\n')).not.toMatch(/retryable failure spike/);
    expect(health.warnings.join('\n')).toMatch(/concentrated in one owner/);
  });

  it('does not flag a re-enqueue loop hammering a few URLs as a spike', async () => {
    // Prod shape from 2026-08-21: one client loop minted 92 jobs for a
    // single dead URL while Wayback was down. Job count spikes, distinct
    // URL count (from the per-owner failure hashes) does not — the
    // pipeline itself is fine.
    const redis = await healthyRedis();
    const owner = 'c'.repeat(64);
    for (let i = 0; i < 40; i += 1) {
      await redis.set(`dm:archive:done:lifetime:loop-${i}`, JSON.stringify({
        jobId: `lifetime:loop-${i}`,
        status: 'failed',
        kind: 'webpage',
        completedAt: NOW_SECONDS - 60,
        errorCategory: 'retryable',
        error: 'page.goto: net::ERR_HTTP2_PROTOCOL_ERROR',
      }));
    }
    for (let i = 0; i < 2; i += 1) {
      redis.setHashField(`dm:archive-failures:${owner}`, `url-${i}`, JSON.stringify({
        jobId: `lifetime:loop-${i}`,
        ownerPubkey: owner,
        url: `https://www.washingtonpost.com/dead-article-${i}`,
        reason: 'failed',
        failedAt: NOW_SECONDS - 60,
      }));
    }

    const health = await collectArchiveHealth(redis as unknown as Redis, { nowMs: NOW_MS });

    expect(health.sla.webpageRetryableFailedLast24h).toBe(40);
    expect(health.sla.webpageRetryableFailedUrlsLast24h).toBe(2);
    expect(health.issues.join('\n')).not.toMatch(/retryable failure spike/);
  });

  it('ignores stale and permanent failure records when counting distinct failing URLs', async () => {
    const redis = await healthyRedis();
    const owner = 'c'.repeat(64);
    const entry = (field: string, overrides: Record<string, unknown>) =>
      redis.setHashField(`dm:archive-failures:${owner}`, field, JSON.stringify({
        jobId: `lifetime:${field}`,
        ownerPubkey: owner,
        url: `https://example.com/${field}`,
        reason: 'timeout',
        failedAt: NOW_SECONDS - 60,
        ...overrides,
      }));
    entry('fresh-retryable', {});
    entry('stale-retryable', { failedAt: NOW_SECONDS - 25 * 3600 });
    entry('fresh-permanent', { reason: 'not-found' });

    const health = await collectArchiveHealth(redis as unknown as Redis, { nowMs: NOW_MS });

    expect(health.sla.webpageRetryableFailedUrlsLast24h).toBe(1);
  });

  it('does not warn when stale audit rows were handled during the pass', async () => {
    const redis = await healthyRedis();
    await redis.set('dm:archive-audit:last', JSON.stringify({
      at: NOW_SECONDS - 30,
      scanned: 1000,
      completed: 751,
      live: 0,
      failed: 0,
      stale: 249,
      pending: 0,
      renotified: 0,
      requeued: 7,
      rescued: 0,
      markedLostFailed: 242,
      skippedNonRescuable: 0,
      errors: 0,
      truncated: true,
    }));

    const health = await collectArchiveHealth(redis as unknown as Redis, { nowMs: NOW_MS });

    expect(health.ok).toBe(true);
    expect(health.warnings).toEqual([]);
    expect(health.lastAudit?.requeued).toBe(7);
    expect(health.lastAudit?.markedLostFailed).toBe(242);
  });

  it('does not warn when stale audit rows were intentionally skipped as non-rescuable', async () => {
    const redis = await healthyRedis();
    await redis.set('dm:archive-audit:last', JSON.stringify({
      at: NOW_SECONDS - 30,
      scanned: 1000,
      completed: 724,
      live: 12,
      failed: 0,
      stale: 264,
      pending: 0,
      requeueDeferred: 2,
      rescueDeferred: 3,
      waybackMiss: 2,
      skippedNonRescuable: 259,
      errors: 0,
      truncated: true,
    }));

    const health = await collectArchiveHealth(redis as unknown as Redis, { nowMs: NOW_MS });

    expect(health.ok).toBe(true);
    expect(health.warnings).toEqual([]);
    expect(health.lastAudit?.skippedNonRescuable).toBe(259);
  });

  it('flags stale worker heartbeat and latest audit errors', async () => {
    const redis = await healthyRedis();
    redis.idle.set('dm:archive:worker-heartbeat', 301);
    await redis.set('dm:archive-audit:last', JSON.stringify({
      at: NOW_SECONDS - 30,
      scanned: 10,
      errors: 2,
    }));

    const health = await collectArchiveHealth(redis as unknown as Redis, { nowMs: NOW_MS });

    expect(health.ok).toBe(false);
    expect(health.issues.join('\n')).toMatch(/heartbeat stale/);
    expect(health.issues.join('\n')).toMatch(/2 errors/);
  });
});
