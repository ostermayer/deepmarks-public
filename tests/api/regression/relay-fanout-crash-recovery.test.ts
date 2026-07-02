// Regression: the publish-relay drain used BRPOP, so an event lived only in
// worker memory between the pop and the forward to strfry — a SIGKILL/OOM
// there permanently lost a 202-acknowledged save. The loop now BLMOVEs each
// event into a per-worker processing list and recoverPublishRelayOrphans
// re-queues a dead worker's list on the next boot (a live worker's list,
// identified by its heartbeat key, is left alone).

import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';

import { RelayFanoutWorker } from '@src/workers/relay-fanout.js';

const QUEUE = 'dm:publish-relay:queue';
const PROCESSING = 'dm:publish-relay:processing:';
const ACTIVE = 'dm:publish-relay:active:';

class FakeRedis {
  kv = new Map<string, string>();
  lists = new Map<string, string[]>();
  async set(k: string, v: string): Promise<'OK'> { this.kv.set(k, v); return 'OK'; }
  async exists(k: string): Promise<number> { return this.kv.has(k) || this.lists.has(k) ? 1 : 0; }
  async del(k: string): Promise<number> { return (this.kv.delete(k) || this.lists.delete(k)) ? 1 : 0; }
  async lrange(k: string): Promise<string[]> { return [...(this.lists.get(k) ?? [])]; }
  async scan(_c: string, _m: string, pattern: string): Promise<[string, string[]]> {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    const keys = [...this.lists.keys(), ...this.kv.keys()].filter((k) => k.startsWith(prefix));
    return ['0', keys];
  }
  multi() {
    const ops: Array<() => void> = [];
    const chain = {
      rpush: (k: string, v: string) => {
        ops.push(() => { const l = this.lists.get(k) ?? []; l.push(v); this.lists.set(k, l); });
        return chain;
      },
      del: (k: string) => { ops.push(() => { this.kv.delete(k); this.lists.delete(k); }); return chain; },
      exec: async () => { for (const op of ops) op(); return ops.map(() => [null, 1]); },
    };
    return chain;
  }
}

function worker(redis: FakeRedis): { recoverPublishRelayOrphans(): Promise<void> } {
  const w = new RelayFanoutWorker({
    redis: redis as unknown as Redis,
    relayUrl: 'ws://strfry:7777',
    canonicalRelayUrl: 'wss://relay.deepmarks.org',
    logger: { info() {}, warn() {}, error() {} },
  });
  return w as unknown as { recoverPublishRelayOrphans(): Promise<void> };
}

describe('publish-relay crash recovery', () => {
  it("re-queues a dead worker's stranded events (no heartbeat)", async () => {
    const redis = new FakeRedis();
    redis.lists.set(`${PROCESSING}w-dead`, ['{"id":"evt1"}', '{"id":"evt2"}']);
    // No dm:publish-relay:active:w-dead — the worker is gone.

    await worker(redis).recoverPublishRelayOrphans();

    expect(redis.lists.get(QUEUE)).toEqual(['{"id":"evt1"}', '{"id":"evt2"}']);
    expect(redis.lists.has(`${PROCESSING}w-dead`)).toBe(false);
  });

  it("leaves a live worker's processing list alone (heartbeat present)", async () => {
    const redis = new FakeRedis();
    redis.lists.set(`${PROCESSING}w-live`, ['{"id":"evt3"}']);
    redis.kv.set(`${ACTIVE}w-live`, '1'); // heartbeat → still draining

    await worker(redis).recoverPublishRelayOrphans();

    expect(redis.lists.get(QUEUE)).toBeUndefined(); // not reclaimed
    expect(redis.lists.get(`${PROCESSING}w-live`)).toEqual(['{"id":"evt3"}']);
  });

  it('drops an empty orphaned processing list without touching the queue', async () => {
    const redis = new FakeRedis();
    redis.lists.set(`${PROCESSING}w-empty`, []);

    await worker(redis).recoverPublishRelayOrphans();

    expect(redis.lists.has(`${PROCESSING}w-empty`)).toBe(false);
    expect(redis.lists.get(QUEUE)).toBeUndefined();
  });
});
