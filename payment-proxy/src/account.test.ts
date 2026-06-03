import { describe, it, expect, beforeEach } from 'vitest';
import { AccountStore, hashEmail } from './account.js';
import type { Account } from './account.js';

// Small in-memory Redis double — only the surface AccountStore touches.
class FakeRedis {
  kv = new Map<string, string>();
  async get(k: string) { return this.kv.get(k) ?? null; }
  async set(k: string, v: string) { this.kv.set(k, v); return 'OK'; }
  async del(k: string) { return this.kv.delete(k) ? 1 : 0; }
  multi() {
    const ops: Array<() => Promise<unknown>> = [];
    const chain = {
      set: (k: string, v: string) => { ops.push(() => this.set(k, v)); return chain; },
      del: (k: string) => { ops.push(() => this.del(k)); return chain; },
      exec: async () => {
        const out: unknown[] = [];
        for (const op of ops) out.push([null, await op()]);
        return out;
      }
    };
    return chain;
  }
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  const pubkey = overrides.pubkey ?? 'a'.repeat(64);
  return {
    emailHash: overrides.emailHash ?? hashEmail('alice@example.com'),
    pubkey,
    encryptedViewKey: 'cipher',
    salt: 'salt',
    kdfParams: { algorithm: 'argon2id', memory: 65536, iterations: 3, parallelism: 1 },
    sessionVersion: 0,
    createdAt: 1_700_000_000,
    ...overrides
  };
}

function setup(): { store: AccountStore; redis: FakeRedis } {
  const redis = new FakeRedis();
  const store = new AccountStore(redis as unknown as import('ioredis').Redis);
  return { store, redis };
}

describe('AccountStore.isLifetimeMember', () => {
  it('returns false for an unknown pubkey', async () => {
    const { store } = setup();
    expect(await store.isLifetimeMember('b'.repeat(64))).toBe(false);
  });

  it('returns false for an existing account with no lifetime marker', async () => {
    const { store } = setup();
    await store.create(makeAccount());
    expect(await store.isLifetimeMember('a'.repeat(64))).toBe(false);
  });

  it('returns true once lifetimePaidAt is stamped', async () => {
    const { store } = setup();
    await store.create(makeAccount());
    await store.markLifetimePaid('a'.repeat(64), 1_700_000_123);
    expect(await store.isLifetimeMember('a'.repeat(64))).toBe(true);
  });
});

describe('AccountStore.markLifetimePaid', () => {
  it('persists the payment timestamp on the account record', async () => {
    const { store } = setup();
    await store.create(makeAccount());
    await store.markLifetimePaid('a'.repeat(64), 1_700_000_123);
    const loaded = await store.getByPubkey('a'.repeat(64));
    expect(loaded?.lifetimePaidAt).toBe(1_700_000_123);
  });

  it('is idempotent — a second call does not overwrite the original timestamp', async () => {
    const { store } = setup();
    await store.create(makeAccount());
    await store.markLifetimePaid('a'.repeat(64), 1);
    await store.markLifetimePaid('a'.repeat(64), 9999);
    const loaded = await store.getByPubkey('a'.repeat(64));
    expect(loaded?.lifetimePaidAt).toBe(1);
  });

  it('defaults `at` to now() when no explicit timestamp is passed', async () => {
    const { store } = setup();
    await store.create(makeAccount());
    const before = Math.floor(Date.now() / 1000);
    await store.markLifetimePaid('a'.repeat(64));
    const loaded = await store.getByPubkey('a'.repeat(64));
    expect(loaded?.lifetimePaidAt).toBeGreaterThanOrEqual(before);
  });

  it('throws when the pubkey has no account', async () => {
    const { store } = setup();
    await expect(store.markLifetimePaid('c'.repeat(64))).rejects.toThrow(/account/i);
  });
});
