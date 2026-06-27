import { describe, expect, it } from 'vitest';

import { scheduleActiveUserFriendWarmup, warmFollowSource } from '@src/friend-cache-warmup.js';

class FakeRedis {
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  lists = new Map<string, string[]>();
  deleted: string[] = [];

  async set(key: string, value: string, _ex: 'EX', _ttl: number, nx: 'NX'): Promise<'OK' | null> {
    if (nx === 'NX' && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    this.deleted.push(key);
    const existed = this.strings.delete(key) ? 1 : 0;
    this.sets.delete(key);
    return existed;
  }

  async smembers(key: string): Promise<string[]> {
    return Array.from(this.sets.get(key) ?? []);
  }

  async lpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }

  multi(): FakePipeline {
    return new FakePipeline(this);
  }

  pipeline(): FakePipeline {
    return new FakePipeline(this);
  }

  saddNow(key: string, values: string[]): void {
    const set = this.sets.get(key) ?? new Set<string>();
    for (const value of values) set.add(value);
    this.sets.set(key, set);
  }
}

class FakePipeline {
  private readonly ops: Array<() => void> = [];

  constructor(private readonly redis: FakeRedis) {}

  del(key: string): this {
    this.ops.push(() => {
      this.redis.deleted.push(key);
      this.redis.strings.delete(key);
      this.redis.sets.delete(key);
    });
    return this;
  }

  sadd(key: string, ...values: string[]): this {
    this.ops.push(() => this.redis.saddNow(key, values));
    return this;
  }

  expire(_key: string, _seconds: number): this {
    return this;
  }

  async exec(): Promise<unknown[]> {
    for (const op of this.ops) op();
    return [];
  }
}

const owner = 'a'.repeat(64);
const friendA = 'b'.repeat(64);
const friendB = 'c'.repeat(64);

describe('friend cache warmup', () => {
  it('stores a published kind:3 contact list and prioritizes followed pubkeys', async () => {
    const redis = new FakeRedis();

    await warmFollowSource(redis as never, {
      kind: 3,
      pubkey: owner,
      tags: [
        ['p', friendA],
        ['p', friendB.toUpperCase()],
        ['p', 'not-a-pubkey'],
      ],
    });

    expect(redis.sets.get(`dm:follows:by-user:${owner}`)).toEqual(new Set([friendA, friendB]));
    expect(redis.sets.get('dm:contacts:watched')).toEqual(new Set([friendA, friendB]));
    expect(redis.deleted).toContain(`dm:contacts:last-ingest:v2:${friendA}`);
    expect(redis.deleted).toContain(`dm:contacts:last-ingest:v2:${friendB}`);
  });

  it('prioritizes known follows when an active user saves a bookmark', async () => {
    const redis = new FakeRedis();
    redis.saddNow(`dm:follows:by-user:${owner}`, [friendA, friendB]);

    await scheduleActiveUserFriendWarmup(redis as never, owner);

    expect(redis.deleted).toContain(`dm:contacts:sync:last:${owner}`);
    expect(redis.sets.get('dm:contacts:watched')).toEqual(new Set([friendA, friendB]));
    expect(redis.deleted).toContain(`dm:contacts:last-ingest:v2:${friendA}`);
    expect(redis.deleted).toContain(`dm:contacts:last-ingest:v2:${friendB}`);
    expect(redis.lists.get('dm:onboarding:queue')).toBeUndefined();
  });

  it('schedules a bounded contact refresh when no follow cache exists yet', async () => {
    const redis = new FakeRedis();

    await scheduleActiveUserFriendWarmup(redis as never, owner);

    expect(redis.lists.get('dm:onboarding:priority-queue')).toEqual([owner]);
    expect(redis.lists.get('dm:onboarding:queue')).toBeUndefined();
    expect(redis.deleted).toContain(`dm:onboarding:done:${owner}`);
  });
});
