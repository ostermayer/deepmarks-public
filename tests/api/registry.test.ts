import { describe, expect, it, vi } from 'vitest';

import { backfillRegistry, recordAuthenticatedPubkey, registerPubkey } from '@src/registry.js';

class FakeRedis {
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  lists = new Map<string, string[]>();
  hashKeys = new Map<string, string[]>();
  scanResults = new Map<string, string[][]>();
  deleted: string[] = [];
  scansRun = 0;
  hkeysRun = 0;

  async sadd(key: string, value: string): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    const before = set.size;
    set.add(value);
    this.sets.set(key, set);
    return set.size - before;
  }

  /** ioredis-style variadic SET. Honours both the 3-arg
   *  `set(key, value, 'NX')` and 5-arg `set(key, value, 'EX', ttl, 'NX')`
   *  forms. We need the TTL-less `NX` form for the backfill marker. */
  async set(
    key: string,
    value: string,
    flagOrEx: 'NX' | 'EX' | 'PX' | undefined = undefined,
    _ttl?: number,
    nx?: 'NX',
  ): Promise<'OK' | null> {
    const wantsNx = flagOrEx === 'NX' || nx === 'NX';
    if (wantsNx && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    this.deleted.push(key);
    const existed = this.strings.delete(key) ? 1 : 0;
    return existed;
  }

  async lpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }

  async scan(_cursor: string, _match: unknown, _count: unknown): Promise<[string, string[]]> {
    this.scansRun += 1;
    const cursor = _cursor === '0' ? '0' : _cursor;
    const batch = this.scanResults.get(cursor) ?? [];
    return ['0', batch];
  }

  async hkeys(key: string): Promise<string[]> {
    this.hkeysRun += 1;
    return this.hashKeys.get(key) ?? [];
  }

  async scard(key: string): Promise<number> {
    return this.sets.get(key)?.size ?? 0;
  }

  seedRegistered(pubkey: string): void {
    const set = this.sets.get('dm:registered:pubkeys') ?? new Set<string>();
    set.add(pubkey);
    this.sets.set('dm:registered:pubkeys', set);
  }

  /** Test-only: return the FakeRedis-set 'OK' from a `set(...'NX')`
   *  call WHEN the key is unset; null once a prior boot set it. */
  markerState(key: string): string | undefined {
    return this.strings.get(key);
  }
}

describe('registry onboarding import queueing', () => {
  it('queues the first-ever onboarding scan when a pubkey is registered', async () => {
    const redis = new FakeRedis();
    const pubkey = '1'.repeat(64);

    await expect(registerPubkey(redis as never, pubkey)).resolves.toBe(true);

    expect(redis.lists.get('dm:onboarding:queue')).toEqual([pubkey]);
  });

  it('queues a scan refresh for an already-registered authenticated user', async () => {
    const redis = new FakeRedis();
    const pubkey = '2'.repeat(64);
    redis.seedRegistered(pubkey);

    await recordAuthenticatedPubkey(redis as never, pubkey);

    expect(redis.deleted).toContain(`dm:onboarding:done:${pubkey}`);
    expect(redis.lists.get('dm:onboarding:priority-queue')).toEqual([pubkey]);
    expect(redis.lists.get('dm:onboarding:queue')).toBeUndefined();
  });

  it('throttles repeated authenticated scan refreshes', async () => {
    const redis = new FakeRedis();
    const pubkey = '3'.repeat(64);
    redis.seedRegistered(pubkey);

    await recordAuthenticatedPubkey(redis as never, pubkey);
    await recordAuthenticatedPubkey(redis as never, pubkey);

    expect(redis.lists.get('dm:onboarding:priority-queue')).toEqual([pubkey]);
  });
});

describe('backfillRegistry — idempotent across restarts', () => {
  it('runs SCAN + SADD on the first call and skips on a subsequent boot', async () => {
    const redis = new FakeRedis();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    // Seed lifetime + username + public-bookmark-author sources so the
    // first run has work to do.
    const pk1 = 'a'.repeat(64);
    const pk2 = 'b'.repeat(64);
    const pk3 = 'c'.repeat(64);
    // SCAN always returns one batch keyed off the cursor we use (the
    // FakeRedis treats match fields opaquely). We register 1 batch per
    // call.
    redis.scanResults.set('0', [
      `dm:lifetime:${pk1}`,
      `dm:public-bookmarks:author:${pk3}`,
    ]);
    redis.hashKeys.set('dm:username:bypubkey', [pk2]);

    // First boot — populates pubkeys set, writes marker.
    await backfillRegistry(redis as never, logger);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ added: 3 }),
      'registry backfill complete',
    );
    const firstScanCount = redis.scansRun;
    const firstHkeysCount = redis.hkeysRun;
    expect(redis.markerState('dm:registry:backfill-done:v1')).toBe('1');
    // Assert the expected pubkeys landed in the registry set.
    expect(redis.sets.get('dm:registered:pubkeys')).toContain(pk1);
    expect(redis.sets.get('dm:registered:pubkeys')).toContain(pk2);
    expect(redis.sets.get('dm:registered:pubkeys')).toContain(pk3);

    // Second boot — marker is set, must short-circuit.
    const logger2 = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    await backfillRegistry(redis as never, logger2);
    expect(logger2.info).toHaveBeenCalledWith(
      'registry backfill already complete on a previous boot — skipping',
    );
    expect(redis.scansRun, 'no extra SCAN on the second boot').toBe(firstScanCount);
    expect(redis.hkeysRun, 'no extra HKEYS on the second boot').toBe(firstHkeysCount);
  });
});

describe('backfillRegistry — partial-failure retry', () => {
  it('clears the marker when SCAN throws so the next boot retries', async () => {
    const redis = new FakeRedis();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    // SCAN throws for every call (simulate a Redis hiccup).
    const scanSpy = vi.spyOn(redis, 'scan').mockRejectedValue(new Error('redis down'));
    // SADD must still succeed so added is non-zero if SCAN happens.

    await backfillRegistry(redis as never, logger);

    // Marker must be cleared so the next boot retries instead of
    // skipping on a false-positive marker.
    expect(redis.deleted).toContain('dm:registry:backfill-done:v1');
    // Both SCAN-backed sources (lifetime, public-bookmarks-author)
    // throw; the single-hash username source resolves cleanly so the
    // failure count is 2, not 3.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failures: 2 }),
      'registry backfill partially failed — marker cleared, will retry next boot',
    );
    scanSpy.mockRestore();
  });
});
