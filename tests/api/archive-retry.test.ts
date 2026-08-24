import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';

import {
  archiveFailureRetryEligibility,
  retryTerminalArchiveFailures,
} from '@src/archive-retry.js';
import type { ArchiveFailureRecord } from '@src/archive-failures.js';
import type { PurchaseStore } from '@src/queue.js';
import type { PurchaseRecord } from '@src/types.js';

class FakeRedis {
  kv = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    if (args.includes('NX') && this.kv.has(key)) return null;
    this.kv.set(key, value);
    return 'OK';
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }
}

class FakePurchaseStore {
  records: PurchaseRecord[] = [];
  queued: PurchaseRecord[] = [];

  async create(record: PurchaseRecord): Promise<void> {
    this.records.push({ ...record });
  }

  async markPaid(paymentHash: string): Promise<PurchaseRecord | null> {
    const record = this.records.find((item) => item.paymentHash === paymentHash);
    if (!record) return null;
    record.status = 'paid';
    record.paidAt = 1_700_000_001;
    return record;
  }

  async enqueueArchiveJob(record: PurchaseRecord): Promise<void> {
    this.queued.push({ ...record });
  }

  async rollbackToPending(): Promise<void> {}
}

describe('terminal archive retry', () => {
  it('requeues replayable public archive failures and skips private failures', async () => {
    const owner = 'a'.repeat(64);
    const redis = failuresRedis(owner, [
      failure({
        ownerPubkey: owner,
        url: 'https://example.com/post',
        eventId: 'e'.repeat(64),
        tier: 'public',
        kind: 'webpage',
        mirrorUrls: ['https://mirror.example'],
        bookmarkSavedAt: 1_700_000_123,
      }),
      failure({
        ownerPubkey: owner,
        url: 'https://private.example/post',
        tier: 'private',
        kind: 'webpage',
      }),
    ]);
    const purchases = new FakePurchaseStore();

    const result = await retryTerminalArchiveFailures(deps(redis, purchases), {
      ownerPubkey: owner,
      dryRun: false,
      force: true,
      limit: 10,
    });

    expect(result).toMatchObject({ scanned: 2, processed: 2, enqueued: 1, skipped: 1, dryRun: false });
    expect(result.results.find((item) => item.url === 'https://private.example/post')?.skippedReason)
      .toBe('private-archive');
    expect(purchases.queued).toHaveLength(1);
    expect(purchases.queued[0]).toMatchObject({
      url: 'https://example.com/post',
      eventId: 'e'.repeat(64),
      userPubkey: owner,
      tier: 'public',
      mirrorUrls: ['https://mirror.example'],
      bookmarkSavedAt: 1_700_000_123,
    });
    expect(purchases.queued[0]?.paymentHash).toMatch(/^lifetime:[0-9a-f]{32}$/);
  });

  it('does not enqueue the same failed URL twice without force', async () => {
    const owner = 'b'.repeat(64);
    const redis = failuresRedis(owner, [failure({ ownerPubkey: owner, url: 'https://example.com/post' })]);
    const purchases = new FakePurchaseStore();

    const first = await retryTerminalArchiveFailures(deps(redis, purchases), {
      ownerPubkey: owner,
      dryRun: false,
    });
    const second = await retryTerminalArchiveFailures(deps(redis, purchases), {
      ownerPubkey: owner,
      dryRun: false,
    });

    expect(first.enqueued).toBe(1);
    expect(second.enqueued).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.results[0]?.skippedReason).toBe('already-retried-recently');
    expect(purchases.queued).toHaveLength(1);
  });

  it('applies limit to eligible retries, not skipped private rows', async () => {
    const owner = 'c'.repeat(64);
    const redis = failuresRedis(owner, [
      failure({ ownerPubkey: owner, url: 'https://private-one.example/post', tier: 'private', failedAt: 1_700_000_010 }),
      failure({ ownerPubkey: owner, url: 'https://private-two.example/post', tier: 'private', failedAt: 1_700_000_009 }),
      failure({ ownerPubkey: owner, url: 'https://public-one.example/post', tier: 'public', failedAt: 1_700_000_008 }),
      failure({ ownerPubkey: owner, url: 'https://public-two.example/post', tier: 'public', failedAt: 1_700_000_007 }),
    ]);
    const purchases = new FakePurchaseStore();

    const result = await retryTerminalArchiveFailures(deps(redis, purchases), {
      ownerPubkey: owner,
      dryRun: false,
      force: true,
      limit: 1,
    });

    expect(result.enqueued).toBe(1);
    expect(result.skipped).toBe(2);
    expect(purchases.queued).toHaveLength(1);
    expect(purchases.queued[0]?.url).toBe('https://public-one.example/post');
  });

  it('rejects non-replayable terminal failures', () => {
    expect(archiveFailureRetryEligibility(failure({ tier: 'private' }))).toMatchObject({
      eligible: false,
      reason: 'private-archive',
    });
    expect(archiveFailureRetryEligibility(failure({ kind: 'media' }))).toMatchObject({
      eligible: false,
      reason: 'non-replayable-archive',
    });
    expect(archiveFailureRetryEligibility(failure({ url: 'http://127.0.0.1/admin' }))).toMatchObject({
      eligible: false,
      reason: 'unsafe-source-url',
    });
  });

  it('rejects permanent failures — a blind same-URL retry cannot fix a gone page', () => {
    expect(archiveFailureRetryEligibility(failure({ reason: 'not-found' }))).toMatchObject({
      eligible: false,
      reason: 'permanent-failure',
    });
    expect(archiveFailureRetryEligibility(failure({ reason: 'too-large' }))).toMatchObject({
      eligible: false,
      reason: 'permanent-failure',
    });
    // Blocks lift and rescue exists — site-blocked stays retryable.
    expect(archiveFailureRetryEligibility(failure({ reason: 'site-blocked' }))).toMatchObject({
      eligible: true,
    });
  });
});

function deps(redis: FakeRedis, purchases: FakePurchaseStore) {
  return {
    redis: redis as unknown as Redis,
    purchases: purchases as unknown as PurchaseStore,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

function failuresRedis(ownerPubkey: string, failures: ArchiveFailureRecord[]): FakeRedis {
  const redis = new FakeRedis();
  const hash = new Map<string, string>();
  for (const item of failures) hash.set(item.url, JSON.stringify(item));
  redis.hashes.set(`dm:archive-failures:${ownerPubkey}`, hash);
  return redis;
}

function failure(overrides: Partial<ArchiveFailureRecord> = {}): ArchiveFailureRecord {
  return {
    jobId: 'lifetime:abc123',
    ownerPubkey: 'a'.repeat(64),
    url: 'https://example.com/post',
    reason: 'failed',
    message: 'Archive failed.',
    failedAt: 1_700_000_000,
    tier: 'public',
    kind: 'webpage',
    ...overrides,
  };
}
