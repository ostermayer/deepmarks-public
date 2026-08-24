import { describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import {
  MIRROR_RETRY_BACKOFF_SECONDS,
  MIRROR_RETRY_KEY,
  claimDueMirrorRetries,
  isPermanentMirrorLegError,
  purgeMirrorRetries,
  scheduleMirrorRetry,
  type MirrorRetryEntry,
} from '@src/mirror-retry.js';

class FakeZsetRedis {
  zset = new Map<string, number>();

  async zadd(_key: string, score: number, member: string): Promise<number> {
    this.zset.set(member, Number(score));
    return 1;
  }

  async zrangebyscore(
    _key: string,
    min: number | string,
    max: number | string,
    _limit: string,
    _offset: number,
    count: number,
  ): Promise<string[]> {
    return [...this.zset.entries()]
      .filter(([, score]) => score >= Number(min) && score <= Number(max))
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member)
      .slice(0, count);
  }

  async zrem(_key: string, member: string): Promise<number> {
    return this.zset.delete(member) ? 1 : 0;
  }

  async zrange(_key: string, _start: number, _stop: number): Promise<string[]> {
    return [...this.zset.keys()];
  }
}

const NOW = 1_700_000_000;

function entry(overrides: Partial<MirrorRetryEntry> = {}): MirrorRetryEntry {
  return {
    blobHash: 'a'.repeat(64),
    urls: ['https://blossom.primal.net'],
    contentType: 'text/html',
    attempt: 0,
    jobId: 'lifetime:test',
    ...overrides,
  };
}

describe('scheduleMirrorRetry', () => {
  it('parks the entry at now + the backoff step for its attempt', async () => {
    const redis = new FakeZsetRedis();
    const scheduled = await scheduleMirrorRetry(redis as unknown as Redis, entry(), NOW);

    expect(scheduled).toBe(true);
    const [member, score] = [...redis.zset.entries()][0]!;
    expect(score).toBe(NOW + MIRROR_RETRY_BACKOFF_SECONDS[0]);
    expect(JSON.parse(member).blobHash).toBe('a'.repeat(64));
  });

  it('uses the widening step for later attempts', async () => {
    const redis = new FakeZsetRedis();
    await scheduleMirrorRetry(redis as unknown as Redis, entry({ attempt: 2 }), NOW);
    expect([...redis.zset.values()][0]).toBe(NOW + MIRROR_RETRY_BACKOFF_SECONDS[2]);
  });

  it('refuses once the backoff schedule is exhausted', async () => {
    const redis = new FakeZsetRedis();
    const scheduled = await scheduleMirrorRetry(
      redis as unknown as Redis,
      entry({ attempt: MIRROR_RETRY_BACKOFF_SECONDS.length }),
      NOW,
    );
    expect(scheduled).toBe(false);
    expect(redis.zset.size).toBe(0);
  });

  it('refuses an entry with no urls left', async () => {
    const redis = new FakeZsetRedis();
    const scheduled = await scheduleMirrorRetry(redis as unknown as Redis, entry({ urls: [] }), NOW);
    expect(scheduled).toBe(false);
    expect(redis.zset.size).toBe(0);
  });
});

describe('claimDueMirrorRetries', () => {
  it('returns only due entries and removes them from the zset', async () => {
    const redis = new FakeZsetRedis();
    const due = entry();
    const future = entry({ blobHash: 'b'.repeat(64) });
    redis.zset.set(JSON.stringify(due), NOW - 10);
    redis.zset.set(JSON.stringify(future), NOW + 9_999);

    const claimed = await claimDueMirrorRetries(redis as unknown as Redis, NOW, 5);

    expect(claimed.map((e) => e.blobHash)).toEqual(['a'.repeat(64)]);
    expect(redis.zset.size).toBe(1);
  });

  it('drops malformed members without returning them', async () => {
    const redis = new FakeZsetRedis();
    redis.zset.set('{not json', NOW - 10);
    redis.zset.set(JSON.stringify({ blobHash: 42, urls: 'nope' }), NOW - 10);

    const claimed = await claimDueMirrorRetries(redis as unknown as Redis, NOW, 5);

    expect(claimed).toEqual([]);
    expect(redis.zset.size).toBe(0);
  });

  it('respects the batch limit', async () => {
    const redis = new FakeZsetRedis();
    for (let i = 0; i < 4; i++) {
      redis.zset.set(JSON.stringify(entry({ blobHash: String(i).repeat(64) })), NOW - 10 + i);
    }

    const claimed = await claimDueMirrorRetries(redis as unknown as Redis, NOW, 2);

    expect(claimed).toHaveLength(2);
    expect(redis.zset.size).toBe(2);
  });
});

describe('purgeMirrorRetries', () => {
  it('removes every pending retry for the blob and nothing else', async () => {
    const redis = new FakeZsetRedis();
    redis.zset.set(JSON.stringify(entry()), NOW + 100);
    redis.zset.set(JSON.stringify(entry({ attempt: 3 })), NOW + 90_000);
    redis.zset.set(JSON.stringify(entry({ blobHash: 'b'.repeat(64) })), NOW + 100);

    const purged = await purgeMirrorRetries(redis as unknown as Redis, 'a'.repeat(64));

    expect(purged).toBe(2);
    expect(redis.zset.size).toBe(1);
    expect(JSON.parse([...redis.zset.keys()][0]!).blobHash).toBe('b'.repeat(64));
  });
});

describe('isPermanentMirrorLegError', () => {
  it('marks all-4xx signatures permanent (nostrcheck type-sniff 400 on encrypted blobs)', () => {
    // Verbatim prod shape, 2026-07-08: nostrcheck 400s every encrypted
    // blob — retrying can never fix a magic-byte rejection.
    expect(isPermanentMirrorLegError(
      'mirror HTTP 400; direct upload failed: blossom upload failed: 400 {"status":"error","message":"file type not detected or not allowed"}',
    )).toBe(true);
    expect(isPermanentMirrorLegError('mirror HTTP 403; direct upload failed: blossom upload failed: 401 Pubkey not on whitelist')).toBe(true);
  });

  it('keeps 5xx signatures retryable (Primal db-error outage shape)', () => {
    expect(isPermanentMirrorLegError('mirror HTTP 500; direct upload failed: blossom upload failed: 500 db error')).toBe(false);
  });

  it('keeps ambiguous, rate-limited, and status-less failures retryable', () => {
    // Mixed 4xx+5xx: unclear signal, keep trying.
    expect(isPermanentMirrorLegError('mirror HTTP 400; direct upload failed: blossom upload failed: 503 overloaded')).toBe(false);
    expect(isPermanentMirrorLegError('mirror HTTP 429; direct upload failed: blossom upload failed: 429 slow down')).toBe(false);
    expect(isPermanentMirrorLegError('mirror failed: fetch failed; direct upload failed: The operation was aborted due to timeout')).toBe(false);
    expect(isPermanentMirrorLegError(undefined)).toBe(false);
  });
});

describe('MIRROR_RETRY_KEY', () => {
  it('stays on the dm:archive prefix shared with the other worker keys', () => {
    expect(MIRROR_RETRY_KEY.startsWith('dm:archive:')).toBe(true);
  });
});
