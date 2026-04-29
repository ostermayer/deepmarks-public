import { beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import {
  RESERVED_USERNAMES,
  UsernameStore,
  isReservedUsername,
  isWellFormedUsername,
} from './username.js';

// ── FakeRedis — just enough of ioredis to exercise UsernameStore ───────
// Supports: hget, hset, hdel, get, set (with EX), del, multi()/exec.
// Everything is in-memory; TTLs are NOT time-based in this fake — they're
// stored + tests advance time via a `tick()` helper.

interface Entry { value: string; expiresAt?: number }

class FakeRedis {
  private now = 0;
  private hashes = new Map<string, Map<string, string>>();
  private strings = new Map<string, Entry>();

  tick(seconds: number) { this.now += seconds; }

  private gcIfExpired(key: string): void {
    const e = this.strings.get(key);
    if (e && e.expiresAt !== undefined && e.expiresAt <= this.now) {
      this.strings.delete(key);
    }
  }

  async hget(hash: string, field: string): Promise<string | null> {
    return this.hashes.get(hash)?.get(field) ?? null;
  }
  async hset(hash: string, field: string, value: string): Promise<number> {
    let h = this.hashes.get(hash);
    if (!h) { h = new Map(); this.hashes.set(hash, h); }
    const fresh = !h.has(field);
    h.set(field, value);
    return fresh ? 1 : 0;
  }
  async hdel(hash: string, field: string): Promise<number> {
    const h = this.hashes.get(hash);
    if (!h || !h.has(field)) return 0;
    h.delete(field);
    return 1;
  }
  async get(key: string): Promise<string | null> {
    this.gcIfExpired(key);
    return this.strings.get(key)?.value ?? null;
  }
  async set(
    key: string,
    value: string,
    _ex?: 'EX',
    ttl?: number,
    nx?: 'NX',
  ): Promise<'OK' | null> {
    // Mirror ioredis SETNX semantics: if NX is set and the key already
    // has a live value, the write is refused and 'null' is returned.
    if (nx === 'NX') {
      this.gcIfExpired(key);
      if (this.strings.has(key)) return null;
    }
    const expiresAt = ttl !== undefined ? this.now + ttl : undefined;
    this.strings.set(key, { value, expiresAt });
    return 'OK';
  }
  async del(key: string): Promise<number> {
    return this.strings.delete(key) ? 1 : 0;
  }

  multi() {
    const ops: Array<() => Promise<unknown>> = [];
    const chain = {
      hset: (hash: string, field: string, value: string) => {
        ops.push(() => this.hset(hash, field, value));
        return chain;
      },
      hdel: (hash: string, field: string) => {
        ops.push(() => this.hdel(hash, field));
        return chain;
      },
      set: (key: string, value: string, ex?: 'EX', ttl?: number) => {
        ops.push(() => this.set(key, value, ex, ttl));
        return chain;
      },
      del: (key: string) => {
        ops.push(() => this.del(key));
        return chain;
      },
      // ioredis exec returns [[err, result], …] — mirror the shape so
      // execOrThrow in the production path doesn't diverge.
      exec: async () => {
        const out: Array<[Error | null, unknown]> = [];
        for (const op of ops) {
          try { out.push([null, await op()]); }
          catch (e) { out.push([e as Error, null]); }
        }
        return out;
      },
    };
    return chain;
  }
}

function makeStore(): { store: UsernameStore; redis: FakeRedis } {
  const redis = new FakeRedis();
  const store = new UsernameStore(redis as unknown as Redis);
  return { store, redis };
}

describe('isWellFormedUsername', () => {
  it('accepts normal lowercase names', () => {
    expect(isWellFormedUsername('alice')).toBe(true);
    expect(isWellFormedUsername('bob99')).toBe(true);
    expect(isWellFormedUsername('web-3')).toBe(true);
    expect(isWellFormedUsername('a1b')).toBe(true); // minimum length
  });
  it('rejects too-short / too-long', () => {
    expect(isWellFormedUsername('ab')).toBe(false);
    expect(isWellFormedUsername('a'.repeat(31))).toBe(false);
  });
  it('rejects leading or trailing dash', () => {
    expect(isWellFormedUsername('-alice')).toBe(false);
    expect(isWellFormedUsername('alice-')).toBe(false);
  });
  it('rejects double-dash runs', () => {
    expect(isWellFormedUsername('al--ice')).toBe(false);
  });
  it('rejects uppercase + special chars', () => {
    expect(isWellFormedUsername('Alice')).toBe(false);
    expect(isWellFormedUsername('alice.bob')).toBe(false);
    expect(isWellFormedUsername('alice_bob')).toBe(false);
    expect(isWellFormedUsername('alice@bob')).toBe(false);
  });
});

describe('isReservedUsername', () => {
  it('flags route collisions', () => {
    expect(isReservedUsername('about')).toBe(true);
    expect(isReservedUsername('settings')).toBe(true);
    expect(isReservedUsername('api')).toBe(true);
  });
  it('flags generic admin words', () => {
    expect(isReservedUsername('admin')).toBe(true);
    expect(isReservedUsername('root')).toBe(true);
  });
  it('does not flag arbitrary names', () => {
    expect(isReservedUsername('alice')).toBe(false);
    expect(isReservedUsername('bob')).toBe(false);
  });
  it('has a sensible cardinality so we haven\'t over-blocked', () => {
    expect(RESERVED_USERNAMES.size).toBeGreaterThan(30);
    expect(RESERVED_USERNAMES.size).toBeLessThan(200);
  });
});

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const PK_C = 'c'.repeat(64);

describe('UsernameStore.claim', () => {
  it('rejects a non-lifetime caller up-front', async () => {
    const { store } = makeStore();
    const r = await store.claim(PK_A, 'alice', /*isLifetime*/ false);
    expect(r).toEqual({ ok: false, error: 'not-lifetime' });
  });

  it('accepts a fresh claim from a lifetime member', async () => {
    const { store } = makeStore();
    const r = await store.claim(PK_A, 'alice', true);
    expect(r).toEqual({ ok: true, name: 'alice' });
    expect(await store.lookup('alice')).toBe(PK_A);
    expect(await store.usernameOf(PK_A)).toBe('alice');
  });

  it('lowercases + trims input before storing', async () => {
    const { store } = makeStore();
    const r = await store.claim(PK_A, '  Alice  ', true);
    expect(r).toEqual({ ok: true, name: 'alice' });
    expect(await store.lookup('ALICE')).toBe(PK_A);
  });

  it('rejects invalid format without touching state', async () => {
    const { store } = makeStore();
    const r = await store.claim(PK_A, '-bad-', true);
    expect(r).toEqual({ ok: false, error: 'invalid' });
    expect(await store.usernameOf(PK_A)).toBeNull();
  });

  it('rejects reserved names', async () => {
    const { store } = makeStore();
    expect(await store.claim(PK_A, 'admin', true)).toEqual({ ok: false, error: 'reserved' });
    expect(await store.claim(PK_A, 'settings', true)).toEqual({ ok: false, error: 'reserved' });
  });

  it('rejects a name already held by another pubkey', async () => {
    const { store } = makeStore();
    await store.claim(PK_A, 'alice', true);
    expect(await store.claim(PK_B, 'alice', true)).toEqual({ ok: false, error: 'taken' });
  });

  it('is a no-op when the same pubkey re-claims its own active handle', async () => {
    const { store } = makeStore();
    await store.claim(PK_A, 'alice', true);
    const r = await store.claim(PK_A, 'alice', true);
    expect(r).toEqual({ ok: true, name: 'alice' });
  });

  it('serializes concurrent claims for the same name (TOCTOU defence)', async () => {
    // Two different pubkeys race for 'alice' at the same time. Exactly
    // one winner; the other gets 'taken'. This failed pre-fix because
    // both saw existingOwner=null and both wrote their own bypubkey
    // entries, leaving the two hashes inconsistent.
    const { store, redis } = makeStore();
    const [a, b] = await Promise.all([
      store.claim(PK_A, 'alice', true),
      store.claim(PK_B, 'alice', true),
    ]);
    const successes = [a, b].filter((r) => r.ok === true);
    const failures = [a, b].filter((r) => r.ok === false);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect((failures[0] as { ok: false; error: string }).error).toBe('taken');
    // The two hashes agree: the winner is in both maps, and the loser
    // is in neither.
    const winnerPk = successes[0]!.ok === true ? (a.ok ? PK_A : PK_B) : '';
    expect(await redis.hget('dm:username:byname', 'alice')).toBe(winnerPk);
    expect(await redis.hget('dm:username:bypubkey', winnerPk)).toBe('alice');
    const loserPk = winnerPk === PK_A ? PK_B : PK_A;
    expect(await redis.hget('dm:username:bypubkey', loserPk)).toBeNull();
  });

  it('releases the previous handle into cooldown when claiming a new one', async () => {
    const { store, redis } = makeStore();
    await store.claim(PK_A, 'alice', true);
    const r = await store.claim(PK_A, 'alice2', true);
    expect(r).toEqual({ ok: true, name: 'alice2' });
    expect(await store.lookup('alice')).toBeNull();
    expect(await store.lookup('alice2')).toBe(PK_A);
    // The old name holds a cooldown for PK_A.
    expect(await redis.get('dm:username:cooldown:alice')).toBe(PK_A);
  });
});

describe('UsernameStore.release + cooldown', () => {
  it('release moves the handle into a 30-day cooldown for the owner', async () => {
    const { store } = makeStore();
    await store.claim(PK_A, 'alice', true);
    const out = await store.release(PK_A);
    expect(out).toEqual({ released: 'alice' });
    expect(await store.lookup('alice')).toBeNull();

    // Another pubkey can't claim during cooldown.
    expect(await store.claim(PK_B, 'alice', true)).toEqual({ ok: false, error: 'cooldown' });
  });

  it('original owner can reclaim instantly during cooldown', async () => {
    const { store } = makeStore();
    await store.claim(PK_A, 'alice', true);
    await store.release(PK_A);
    const r = await store.claim(PK_A, 'alice', true);
    expect(r).toEqual({ ok: true, name: 'alice' });
  });

  it('after cooldown expiry, a different pubkey can claim', async () => {
    const { store, redis } = makeStore();
    await store.claim(PK_A, 'alice', true);
    await store.release(PK_A);
    // Fast-forward past the 30-day window.
    redis.tick(31 * 24 * 60 * 60);
    const r = await store.claim(PK_B, 'alice', true);
    expect(r).toEqual({ ok: true, name: 'alice' });
    expect(await store.lookup('alice')).toBe(PK_B);
  });

  it('release on a pubkey that has no handle is a no-op', async () => {
    const { store } = makeStore();
    const r = await store.release(PK_C);
    expect(r).toEqual({ released: null });
  });
});

describe('UsernameStore.check (availability)', () => {
  it('reports invalid + reserved without hitting storage', async () => {
    const { store } = makeStore();
    expect(await store.check('ab')).toEqual({ available: false, reason: 'invalid' });
    expect(await store.check('admin')).toEqual({ available: false, reason: 'reserved' });
  });

  it('reports taken when held by someone else', async () => {
    const { store } = makeStore();
    await store.claim(PK_A, 'alice', true);
    expect(await store.check('alice')).toEqual({ available: false, reason: 'taken' });
  });

  it('reports available to the current holder (self-check)', async () => {
    const { store } = makeStore();
    await store.claim(PK_A, 'alice', true);
    expect(await store.check('alice', PK_A)).toEqual({ available: true });
  });

  it('reports cooldown to anyone except the cooling pubkey', async () => {
    const { store } = makeStore();
    await store.claim(PK_A, 'alice', true);
    await store.release(PK_A);
    expect(await store.check('alice')).toEqual({ available: false, reason: 'cooldown' });
    expect(await store.check('alice', PK_B)).toEqual({ available: false, reason: 'cooldown' });
    expect(await store.check('alice', PK_A)).toEqual({ available: true });
  });

  it('reports available for a truly free name', async () => {
    const { store } = makeStore();
    expect(await store.check('something-fresh')).toEqual({ available: true });
  });
});
