import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import {
  PENDING_ARCHIVE_TTL_SECONDS,
  claimPendingArchiveJob,
  pendingArchiveClaimKey,
  releasePendingArchiveJob,
} from '../../api/src/archive-dedupe.js';

class FakeRedis {
  kv = new Map<string, string>();
  ttl = new Map<string, number>();

  async set(key: string, value: string, _ex: string, ttl: number, nx?: string): Promise<string | null> {
    if (nx === 'NX' && this.kv.has(key)) return null;
    this.kv.set(key, value);
    this.ttl.set(key, ttl);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }

  async del(key: string): Promise<number> {
    return this.kv.delete(key) ? 1 : 0;
  }
}

const OWNER = 'a'.repeat(64);
const URL_A = 'https://example.com/article';

describe('pending-archive claim', () => {
  it('first claim wins; duplicates see the pending jobId', async () => {
    const redis = new FakeRedis();
    const first = await claimPendingArchiveJob(redis as unknown as Redis, 'lifetime', OWNER, URL_A, 'lifetime:aaa');
    expect(first.claimed).toBe(true);

    const second = await claimPendingArchiveJob(redis as unknown as Redis, 'lifetime', OWNER, URL_A, 'lifetime:bbb');
    expect(second.claimed).toBe(false);
    expect(second.existingJobId).toBe('lifetime:aaa');
  });

  it('holds the claim for the full 7-day backstop window', async () => {
    // The 6h default-archive claim TTL is what let a backed-up queue
    // re-admit a duplicate per lapse (2026-07-17 flood); this claim must
    // outlive any realistic queue wait.
    const redis = new FakeRedis();
    await claimPendingArchiveJob(redis as unknown as Redis, 'lifetime', OWNER, URL_A, 'lifetime:aaa');
    expect([...redis.ttl.values()][0]).toBe(PENDING_ARCHIVE_TTL_SECONDS);
    expect(PENDING_ARCHIVE_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it('release is value-matched — a newer claim survives the old job\'s callback', async () => {
    const redis = new FakeRedis();
    await claimPendingArchiveJob(redis as unknown as Redis, 'lifetime', OWNER, URL_A, 'lifetime:aaa');
    // TTL lapsed mid-flight, a newer job re-claimed:
    redis.kv.set(pendingArchiveClaimKey('lifetime', OWNER, URL_A), 'lifetime:ccc');

    await releasePendingArchiveJob(redis as unknown as Redis, 'lifetime', OWNER, URL_A, 'lifetime:aaa');
    expect(redis.kv.get(pendingArchiveClaimKey('lifetime', OWNER, URL_A))).toBe('lifetime:ccc');

    await releasePendingArchiveJob(redis as unknown as Redis, 'lifetime', OWNER, URL_A, 'lifetime:ccc');
    expect(redis.kv.has(pendingArchiveClaimKey('lifetime', OWNER, URL_A))).toBe(false);
  });

  it('webpage and media claims for the same URL do not collide', async () => {
    // A page archive AND a media add-on job of the same video URL are
    // both legitimate — families are separate namespaces.
    const redis = new FakeRedis();
    const web = await claimPendingArchiveJob(redis as unknown as Redis, 'lifetime', OWNER, URL_A, 'lifetime:aaa');
    const media = await claimPendingArchiveJob(redis as unknown as Redis, 'media', OWNER, URL_A, 'media:bbb');
    expect(web.claimed).toBe(true);
    expect(media.claimed).toBe(true);
  });
});
