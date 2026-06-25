import { describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import { ArchiveQueue, KEYS } from '@src/queue.js';

class FakeRedis {
  kv = new Map<string, string>();
  lists = new Map<string, string[]>();

  async scan(_cursor: string, _match: string, pattern: string): Promise<[string, string[]]> {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    return ['0', [...this.lists.keys()].filter((key) => key.startsWith(prefix))];
  }

  async exists(key: string): Promise<number> {
    return this.kv.has(key) ? 1 : 0;
  }

  async lrange(key: string): Promise<string[]> {
    return this.lists.get(key) ?? [];
  }

  async del(key: string): Promise<number> {
    const existed = Number(this.kv.delete(key)) + Number(this.lists.delete(key));
    return existed;
  }

  async rpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }

  multi() {
    const calls: Array<() => Promise<unknown>> = [];
    const chain = {
      rpush: (key: string, value: string) => {
        calls.push(() => this.rpush(key, value));
        return chain;
      },
      del: (key: string) => {
        calls.push(() => this.del(key));
        return chain;
      },
      exec: async () => {
        const results: Array<[Error | null, unknown]> = [];
        for (const call of calls) {
          try {
            results.push([null, await call()]);
          } catch (err) {
            results.push([err as Error, null]);
          }
        }
        return results;
      },
    };
    return chain;
  }
}

describe('ArchiveQueue.recoverOrphans', () => {
  it('requeues dead processing lists but skips workers with active heartbeats', async () => {
    const redis = new FakeRedis();
    const liveWorker = 'w-live';
    const deadWorker = 'w-dead';
    const liveJob = JSON.stringify({ jobId: 'live' });
    const deadJob = JSON.stringify({ jobId: 'dead' });
    redis.kv.set(KEYS.active(liveWorker), liveJob);
    redis.lists.set(KEYS.processing(liveWorker), [liveJob]);
    redis.lists.set(KEYS.processing(deadWorker), [deadJob]);

    const queue = new ArchiveQueue(redis as unknown as Redis, 1_000);
    const result = await queue.recoverOrphans();

    expect(result).toEqual({ recovered: 1 });
    expect(redis.lists.get(KEYS.queue)).toEqual([deadJob]);
    expect(redis.lists.get(KEYS.processing(liveWorker))).toEqual([liveJob]);
    expect(redis.lists.has(KEYS.processing(deadWorker))).toBe(false);
  });
});
