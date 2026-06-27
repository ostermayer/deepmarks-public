import { describe, expect, it } from 'vitest';

import { recordAuthenticatedPubkey, registerPubkey } from '@src/registry.js';

class FakeRedis {
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  lists = new Map<string, string[]>();
  deleted: string[] = [];

  async sadd(key: string, value: string): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    const before = set.size;
    set.add(value);
    this.sets.set(key, set);
    return set.size - before;
  }

  async set(key: string, value: string, _ex: 'EX', _ttl: number, nx?: 'NX'): Promise<'OK' | null> {
    if (nx === 'NX' && this.strings.has(key)) return null;
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

  seedRegistered(pubkey: string): void {
    const set = this.sets.get('dm:registered:pubkeys') ?? new Set<string>();
    set.add(pubkey);
    this.sets.set('dm:registered:pubkeys', set);
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
