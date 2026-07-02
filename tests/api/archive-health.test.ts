import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';

import { collectArchiveHealth } from '@src/archive-health.js';

class FakeRedis {
  kv = new Map<string, string>();
  lists = new Map<string, string[]>();
  idle = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
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
    const keys = [...this.kv.keys(), ...this.lists.keys()].filter((key) => key.startsWith(prefix));
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

  it('flags a queued job older than the alert threshold', async () => {
    const redis = await healthyRedis();
    redis.pushList('dm:archive:queue', archiveJob({ enqueuedAt: NOW_SECONDS - 90_000 }));

    const health = await collectArchiveHealth(redis as unknown as Redis, { nowMs: NOW_MS });

    expect(health.ok).toBe(false);
    expect(health.pending).toBe(1);
    expect(health.oldestQueuedAgeSeconds).toBe(90_000);
    expect(health.issues.join('\n')).toMatch(/oldest archive job/);
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

  it('flags a recent webpage retryable failure spike as an archive health issue', async () => {
    const redis = await healthyRedis();
    for (let i = 0; i < 12; i += 1) {
      await redis.set(`dm:archive:done:lifetime:timeout-${i}`, JSON.stringify({
        jobId: `lifetime:timeout-${i}`,
        status: 'failed',
        kind: 'webpage',
        completedAt: NOW_SECONDS - 60,
        errorCategory: 'retryable',
        error: 'page.goto: Timeout 30000ms exceeded',
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
    expect(health.sla.webpageRetryableFailedLast24h).toBe(12);
    expect(health.sla.webpageTimeoutFailedLast24h).toBe(12);
    expect(health.issues.join('\n')).toMatch(/retryable failure spike/);
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
