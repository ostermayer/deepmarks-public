import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';

import { PurchaseStore } from './queue.js';
import type { ArchiveJob, PurchaseRecord } from './types.js';

class FakeRedis {
  kv = new Map<string, string>();
  lists = new Map<string, string[]>();

  async set(key: string, value: string): Promise<'OK'> {
    this.kv.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }

  async rpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }

  async scan(_cursor: string, _match: string, pattern: string): Promise<[string, string[]]> {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    const keys = [...this.kv.keys(), ...this.lists.keys()].filter((key) => key.startsWith(prefix));
    return ['0', keys];
  }

  async lrange(key: string): Promise<string[]> {
    return this.lists.get(key) ?? [];
  }
}

describe('PurchaseStore archive job metadata', () => {
  it('retains non-secret metadata after enqueue while clearing the archive key from the purchase row', async () => {
    const redis = new FakeRedis();
    const store = new PurchaseStore(redis as unknown as Redis);
    const record: PurchaseRecord = {
      url: 'https://example.com/article',
      userPubkey: 'a'.repeat(64),
      paymentHash: 'lifetime:abc123',
      invoice: '',
      amountSats: 0,
      status: 'paid',
      createdAt: 1_700_000_000,
      paidAt: 1_700_000_001,
      tier: 'private',
      archiveKey: 'A'.repeat(43),
      bookmarkSavedAt: 1_699_999_999,
    };

    await store.enqueueArchiveJob(record);

    const stored = await store.get('lifetime:abc123');
    const metadata = await store.getArchiveJobMetadata('lifetime:abc123');
    expect(stored?.archiveKey).toBeUndefined();
    expect(metadata).toMatchObject({
      jobId: 'lifetime:abc123',
      ownerPubkey: 'a'.repeat(64),
      url: 'https://example.com/article',
      tier: 'private',
      bookmarkSavedAt: 1_699_999_999,
      amountSats: 0,
    });
    expect(JSON.stringify(metadata)).not.toContain('archiveKey');
  });

  it('can validate a legacy in-flight job without exposing its archive key', async () => {
    const redis = new FakeRedis();
    const store = new PurchaseStore(redis as unknown as Redis);
    const job: ArchiveJob = {
      jobId: 'legacy-job',
      paymentHash: 'legacy-job',
      ownerPubkey: 'b'.repeat(64),
      url: 'https://example.net/page',
      tier: 'private',
      archiveKey: 'B'.repeat(43),
      attempts: 0,
      enqueuedAt: 1_700_000_010,
    };
    await redis.set('dm:archive:active:worker-1', JSON.stringify(job));

    const metadata = await store.findActiveArchiveJobMetadata('legacy-job');
    expect(metadata).toMatchObject({
      jobId: 'legacy-job',
      ownerPubkey: 'b'.repeat(64),
      url: 'https://example.net/page',
      tier: 'private',
    });
    expect(JSON.stringify(metadata)).not.toContain('archiveKey');
  });

  it('forces media archives onto the private tier before the worker sees them', async () => {
    const redis = new FakeRedis();
    const store = new PurchaseStore(redis as unknown as Redis);
    const record: PurchaseRecord = {
      url: 'https://www.youtube.com/watch?v=abcDEF123_4',
      userPubkey: 'c'.repeat(64),
      paymentHash: 'media:abc123',
      invoice: '',
      amountSats: 0,
      status: 'paid',
      createdAt: 1_700_000_000,
      paidAt: 1_700_000_001,
      tier: 'public',
      archiveKey: 'C'.repeat(43),
      kind: 'media',
      videoId: 'abcDEF123_4',
      videoContentKey: 'yt:abcdef123_4',
    };

    await store.enqueueArchiveJob(record);

    const queued = redis.lists.get('dm:archive:queue') ?? [];
    expect(queued).toHaveLength(1);
    const job = JSON.parse(queued[0]!) as ArchiveJob;
    expect(job).toMatchObject({
      jobId: 'media:abc123',
      ownerPubkey: 'c'.repeat(64),
      tier: 'private',
      archiveKey: 'C'.repeat(43),
      kind: 'media',
    });

    const stored = await store.get('media:abc123');
    const metadata = await store.getArchiveJobMetadata('media:abc123');
    expect(stored?.archiveKey).toBeUndefined();
    expect(metadata).toMatchObject({
      jobId: 'media:abc123',
      tier: 'private',
      kind: 'media',
      videoContentKey: 'yt:abcdef123_4',
    });
    expect(JSON.stringify(metadata)).not.toContain('archiveKey');
  });
});
