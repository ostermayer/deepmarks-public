// Regression: the invoice settlement handler used a GET+DEL (`consume`) to
// read the pending zap, deleting it BEFORE the bunker signed the kind:9735
// receipt. A transient bunker outage during signing then dropped the receipt
// permanently. ZapStore now uses claim()/finalize()/release(): the record
// survives a signing failure so a redelivered invoice_updated can retry,
// while an NX claim marker still blocks double-publish.

import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';

import { ZapStore } from '@src/queue.js';
import type { PendingZap } from '@src/types.js';

class FakeRedis {
  kv = new Map<string, string>();
  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    if (args.includes('NX') && this.kv.has(key)) return null;
    this.kv.set(key, value);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }
  async del(key: string): Promise<number> {
    return this.kv.delete(key) ? 1 : 0;
  }
}

function pendingZap(): PendingZap {
  return {
    paymentHash: 'a'.repeat(64),
    amountMsat: 21_000,
    invoice: 'lnbc...',
    rawZapRequest: '{"kind":9734}',
    zapRequest: { kind: 9734, pubkey: 'b'.repeat(64), tags: [['p', 'c'.repeat(64)]], sig: '', content: '', created_at: 0, id: '' } as never,
    relays: ['wss://relay.example'],
    createdAt: 0,
  };
}

describe('ZapStore claim/finalize/release', () => {
  const hash = 'a'.repeat(64);

  it('claim returns the record once, blocks a concurrent/duplicate claim', async () => {
    const redis = new FakeRedis();
    const store = new ZapStore(redis as unknown as Redis);
    await store.create(pendingZap());

    const first = await store.claim(hash);
    const second = await store.claim(hash);

    expect(first?.paymentHash).toBe(hash);
    expect(second).toBeNull(); // NX claim marker blocks the duplicate
  });

  it('release re-opens the claim so a redelivered callback can retry (signing failure)', async () => {
    const redis = new FakeRedis();
    const store = new ZapStore(redis as unknown as Redis);
    await store.create(pendingZap());

    const first = await store.claim(hash);
    expect(first).not.toBeNull();
    // Simulate buildZapReceipt throwing (bunker down): release the claim.
    await store.release(hash);

    const retry = await store.claim(hash);
    expect(retry?.paymentHash).toBe(hash); // record survived → retry possible
  });

  it('finalize drops the record and the claim marker keeps blocking redelivery', async () => {
    const redis = new FakeRedis();
    const store = new ZapStore(redis as unknown as Redis);
    await store.create(pendingZap());

    await store.claim(hash);
    await store.finalize(hash); // receipt signed → drop the pending record

    expect(await store.get(hash)).toBeNull();
    // A late redelivery must NOT reprocess: the :claimed marker is still set.
    expect(await store.claim(hash)).toBeNull();
  });
});
