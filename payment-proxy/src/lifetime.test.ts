import { describe, it, expect, beforeEach } from 'vitest';
import { LifetimeStore } from './lifetime.js';

// Minimal in-memory Redis surface. LifetimeStore only touches get / set
// (with NX + EX) / del / exists, so we implement just those.
class FakeRedis {
  kv = new Map<string, string>();
  ttl = new Map<string, number>();
  async get(k: string) { return this.kv.get(k) ?? null; }
  async set(k: string, v: string, ...args: (string | number)[]) {
    // Support:
    //   set(k, v)
    //   set(k, v, 'NX')                      -> only set if missing
    //   set(k, v, 'EX', <seconds>)           -> set with TTL
    const isNx = args.includes('NX');
    if (isNx && this.kv.has(k)) return null;
    this.kv.set(k, v);
    const exIdx = args.findIndex((a) => a === 'EX');
    if (exIdx !== -1) this.ttl.set(k, args[exIdx + 1] as number);
    return 'OK';
  }
  async del(k: string) { return this.kv.delete(k) ? 1 : 0; }
  async exists(k: string) { return this.kv.has(k) ? 1 : 0; }
  // Single-page scan is enough for tests — we only ever have a handful
  // of keys and listMembers loops until cursor === '0'.
  async scan(_cursor: string, _match: string, pattern: string, _count: string, _n: number) {
    const prefix = pattern.replace(/\*$/, '');
    const keys = Array.from(this.kv.keys()).filter((k) => k.startsWith(prefix));
    return ['0', keys];
  }
  async mget(...keys: string[]) {
    return keys.map((k) => this.kv.get(k) ?? null);
  }
}

describe('LifetimeStore.markPaid + isPaid', () => {
  let redis: FakeRedis;
  let store: LifetimeStore;
  const pubkey = 'a'.repeat(64);

  beforeEach(() => {
    redis = new FakeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store = new LifetimeStore(redis as any);
  });

  it('reports isPaid=false for an unknown pubkey', async () => {
    expect(await store.isPaid(pubkey)).toBe(false);
    expect(await store.paidAt(pubkey)).toBeNull();
  });

  it('stamps the paid-at timestamp and reports isPaid=true', async () => {
    await store.markPaid(pubkey, 1_700_000_000);
    expect(await store.isPaid(pubkey)).toBe(true);
    expect(await store.paidAt(pubkey)).toBe(1_700_000_000);
  });

  it('is idempotent — re-calling does not overwrite the original timestamp', async () => {
    await store.markPaid(pubkey, 1_700_000_000);
    await store.markPaid(pubkey, 1_800_000_000);
    expect(await store.paidAt(pubkey)).toBe(1_700_000_000);
  });

  it('defaults to now() when no timestamp is given', async () => {
    const before = Math.floor(Date.now() / 1000);
    await store.markPaid(pubkey);
    const stamped = await store.paidAt(pubkey);
    expect(stamped).not.toBeNull();
    expect(stamped!).toBeGreaterThanOrEqual(before);
  });
});

describe('LifetimeStore pending invoice tracking', () => {
  let redis: FakeRedis;
  let store: LifetimeStore;

  beforeEach(() => {
    redis = new FakeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store = new LifetimeStore(redis as any);
  });

  it('round-trips a pending record', async () => {
    const rec = {
      pubkey: 'a'.repeat(64),
      invoiceId: 'INV_123',
      amountSats: 21000,
      createdAt: 1_700_000_000,
    };
    await store.stagePending(rec);
    expect(await store.getPending('INV_123')).toEqual(rec);
  });

  it('returns null for an unknown invoice', async () => {
    expect(await store.getPending('missing')).toBeNull();
  });

  it('stages with a 24-hour TTL so abandoned invoices age out', async () => {
    await store.stagePending({
      pubkey: 'a'.repeat(64),
      invoiceId: 'INV_TTL',
      amountSats: 21000,
      createdAt: 1,
    });
    expect(redis.ttl.get('dm:lifetime-pending:INV_TTL')).toBe(24 * 60 * 60);
  });

  it('clears a pending record', async () => {
    await store.stagePending({
      pubkey: 'a'.repeat(64),
      invoiceId: 'INV_X',
      amountSats: 21000,
      createdAt: 1,
    });
    await store.clearPending('INV_X');
    expect(await store.getPending('INV_X')).toBeNull();
  });
});

describe('LifetimeStore.listMembers', () => {
  let redis: FakeRedis;
  let store: LifetimeStore;

  beforeEach(() => {
    redis = new FakeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store = new LifetimeStore(redis as any);
  });

  it('returns an empty list when no members', async () => {
    expect(await store.listMembers()).toEqual([]);
  });

  it('returns all members sorted by paidAt ascending', async () => {
    await store.markPaid('b'.repeat(64), 2000);
    await store.markPaid('a'.repeat(64), 1000);
    await store.markPaid('c'.repeat(64), 3000);
    const members = await store.listMembers();
    expect(members).toEqual([
      { pubkey: 'a'.repeat(64), paidAt: 1000 },
      { pubkey: 'b'.repeat(64), paidAt: 2000 },
      { pubkey: 'c'.repeat(64), paidAt: 3000 },
    ]);
  });

  it('ignores pending-invoice keys (different prefix)', async () => {
    await store.markPaid('a'.repeat(64), 1000);
    await store.stagePending({
      pubkey: 'b'.repeat(64),
      invoiceId: 'INV',
      amountSats: 21000,
      createdAt: 1,
    });
    const members = await store.listMembers();
    expect(members).toHaveLength(1);
    expect(members[0].pubkey).toBe('a'.repeat(64));
  });
});
