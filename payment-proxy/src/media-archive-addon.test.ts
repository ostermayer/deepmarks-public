import { beforeEach, describe, expect, it } from 'vitest';
import { MediaArchiveAddonStore } from './media-archive-addon.js';

class FakeRedis {
  kv = new Map<string, string>();
  ttl = new Map<string, number>();

  async get(k: string) { return this.kv.get(k) ?? null; }

  async set(k: string, v: string, ...args: (string | number)[]) {
    const isNx = args.includes('NX');
    if (isNx && this.kv.has(k)) return null;
    this.kv.set(k, v);
    const exIdx = args.findIndex((a) => a === 'EX');
    if (exIdx !== -1) this.ttl.set(k, args[exIdx + 1] as number);
    return 'OK';
  }

  async del(k: string) { return this.kv.delete(k) ? 1 : 0; }
  async exists(k: string) { return this.kv.has(k) ? 1 : 0; }

  async scan(_cursor: string, _match: string, pattern: string, _count: string, _n: number) {
    const prefix = pattern.replace(/\*$/, '');
    const keys = Array.from(this.kv.keys()).filter((k) => k.startsWith(prefix));
    return ['0', keys];
  }

  async mget(...keys: string[]) {
    return keys.map((k) => this.kv.get(k) ?? null);
  }
}

describe('MediaArchiveAddonStore', () => {
  let redis: FakeRedis;
  let store: MediaArchiveAddonStore;

  beforeEach(() => {
    redis = new FakeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store = new MediaArchiveAddonStore(redis as any);
  });

  it('lists paid addon members sorted by first paid timestamp', async () => {
    await store.markPaid('b'.repeat(64), 2000);
    await store.markPaid('a'.repeat(64), 1000);
    await store.markPaid('c'.repeat(64), 3000);

    expect(await store.listMembers()).toEqual([
      { pubkey: 'a'.repeat(64), paidAt: 1000 },
      { pubkey: 'b'.repeat(64), paidAt: 2000 },
      { pubkey: 'c'.repeat(64), paidAt: 3000 },
    ]);
  });

  it('does not include pending invoice records as paid members', async () => {
    await store.markPaid('a'.repeat(64), 1000);
    await store.stagePending({
      pubkey: 'b'.repeat(64),
      invoiceId: 'INV',
      amountSats: 150_000,
      createdAt: 1,
    });

    expect(await store.listMembers()).toEqual([{ pubkey: 'a'.repeat(64), paidAt: 1000 }]);
  });
});
