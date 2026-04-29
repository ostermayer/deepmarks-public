import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generatePlaintextKey,
  hashKey,
  looksLikeApiKey,
  ApiKeyStore
} from './api-keys.js';

// ── Pure helper tests (no Redis) ───────────────────────────────────────

describe('generatePlaintextKey', () => {
  it('returns a key with the dmk_live_ prefix and 43 url-safe body chars', () => {
    for (let i = 0; i < 20; i++) {
      const key = generatePlaintextKey();
      expect(key).toMatch(/^dmk_live_[A-Za-z0-9_-]{43}$/);
    }
  });

  it('never repeats across calls (entropy sanity check)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generatePlaintextKey());
    expect(seen.size).toBe(100);
  });
});

describe('hashKey', () => {
  it('is deterministic — same input → same hash', () => {
    const k = generatePlaintextKey();
    expect(hashKey(k)).toBe(hashKey(k));
  });
  it('returns a 64-char lowercase hex string (256 bits)', () => {
    expect(hashKey('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes wildly on one-byte input change', () => {
    const a = hashKey('dmk_live_x');
    const b = hashKey('dmk_live_y');
    expect(a).not.toBe(b);
  });
});

describe('looksLikeApiKey', () => {
  it('accepts a freshly generated key', () => {
    expect(looksLikeApiKey(generatePlaintextKey())).toBe(true);
  });
  it('rejects missing prefix', () => {
    expect(looksLikeApiKey('live_' + 'A'.repeat(43))).toBe(false);
  });
  it('rejects wrong body length', () => {
    expect(looksLikeApiKey('dmk_live_' + 'A'.repeat(42))).toBe(false);
    expect(looksLikeApiKey('dmk_live_' + 'A'.repeat(44))).toBe(false);
  });
  it('rejects bodies with non-url-safe characters', () => {
    expect(looksLikeApiKey('dmk_live_' + '/'.repeat(43))).toBe(false);
    expect(looksLikeApiKey('dmk_live_' + '+'.repeat(43))).toBe(false);
  });
  it('rejects empty / junk input', () => {
    expect(looksLikeApiKey('')).toBe(false);
    expect(looksLikeApiKey('password123')).toBe(false);
  });
});

// ── Redis-backed store tests (in-memory fake Redis) ────────────────────

class FakeRedis {
  private kv = new Map<string, string>();
  private sets = new Map<string, Set<string>>();

  async get(key: string) { return this.kv.get(key) ?? null; }
  async set(key: string, value: string) { this.kv.set(key, value); return 'OK'; }
  async del(key: string) {
    const existed = this.kv.delete(key);
    this.sets.delete(key);
    return existed ? 1 : 0;
  }
  async sadd(key: string, ...members: string[]) {
    const s = this.sets.get(key) ?? new Set<string>();
    for (const m of members) s.add(m);
    this.sets.set(key, s);
    return members.length;
  }
  async srem(key: string, ...members: string[]) {
    const s = this.sets.get(key);
    if (!s) return 0;
    let n = 0;
    for (const m of members) if (s.delete(m)) n++;
    return n;
  }
  async smembers(key: string) {
    return Array.from(this.sets.get(key) ?? []);
  }
  async mget(...keys: string[]) {
    return keys.map((k) => this.kv.get(k) ?? null);
  }
  multi() {
    const ops: Array<() => Promise<unknown>> = [];
    const chain = {
      set: (k: string, v: string) => { ops.push(() => this.set(k, v)); return chain; },
      del: (k: string) => { ops.push(() => this.del(k)); return chain; },
      sadd: (k: string, m: string) => { ops.push(() => this.sadd(k, m)); return chain; },
      srem: (k: string, m: string) => { ops.push(() => this.srem(k, m)); return chain; },
      exec: async () => {
        const results = [];
        for (const op of ops) results.push([null, await op()]);
        return results;
      }
    };
    return chain;
  }
}

type StoreFixture = {
  redis: FakeRedis;
  store: ApiKeyStore;
};

function setup(): StoreFixture {
  const redis = new FakeRedis();
  // Cast through unknown — FakeRedis implements only the subset we use.
  const store = new ApiKeyStore(redis as unknown as import('ioredis').Redis);
  return { redis, store };
}

describe('ApiKeyStore.create', () => {
  it('returns plaintext exactly once + a record keyed by hash', async () => {
    const { store } = setup();
    const { plaintext, record } = await store.create('pub1', 'laptop');
    expect(plaintext).toMatch(/^dmk_live_/);
    expect(record.hash).toBe(hashKey(plaintext));
    expect(record.pubkey).toBe('pub1');
    expect(record.label).toBe('laptop');
    expect(record.createdAt).toBeGreaterThan(0);
    expect(record.lastUsedAt).toBe(0);
  });

  it('truncates very long labels to 80 chars', async () => {
    const { store } = setup();
    const { record } = await store.create('pub', 'x'.repeat(500));
    expect(record.label.length).toBeLessThanOrEqual(80);
  });

  it('defaults empty / whitespace label to "unnamed"', async () => {
    const { store } = setup();
    const { record } = await store.create('pub', '   ');
    expect(record.label).toBe('unnamed');
  });

  it('does NOT store the plaintext anywhere — only the hash', async () => {
    const { redis, store } = setup();
    const { plaintext, record } = await store.create('pub', 'k');
    // Dump every stored value and verify plaintext never appears.
    // (FakeRedis exposes this via private kv; cast through unknown.)
    const inner = redis as unknown as { kv: Map<string, string> };
    for (const value of inner.kv.values()) {
      expect(value).not.toContain(plaintext);
    }
    // But the hash is findable.
    expect(await redis.get('dm:apikey:' + record.hash)).not.toBeNull();
  });
});

describe('ApiKeyStore.lookup', () => {
  it('finds the record by plaintext key', async () => {
    const { store } = setup();
    const { plaintext, record } = await store.create('pub', 'k');
    const found = await store.lookup(plaintext);
    expect(found?.hash).toBe(record.hash);
  });

  it('returns null for a well-formed but unknown key', async () => {
    const { store } = setup();
    const fake = generatePlaintextKey();
    expect(await store.lookup(fake)).toBeNull();
  });

  it('returns null for malformed input without hitting Redis', async () => {
    const { store } = setup();
    expect(await store.lookup('not-a-key')).toBeNull();
    expect(await store.lookup('')).toBeNull();
  });
});

describe('ApiKeyStore.listByPubkey', () => {
  it('returns keys belonging to the pubkey, newest first', async () => {
    const { store } = setup();
    const a = await store.create('pub', 'alpha');
    // sleep a tick so createdAt differs.
    await new Promise((r) => setTimeout(r, 1100));
    const b = await store.create('pub', 'beta');
    const list = await store.listByPubkey('pub');
    expect(list).toHaveLength(2);
    expect(list[0]!.label).toBe('beta');
    expect(list[1]!.label).toBe('alpha');
    expect(a.record.hash).not.toBe(b.record.hash);
  });

  it('empty list for an unknown pubkey', async () => {
    const { store } = setup();
    expect(await store.listByPubkey('nobody')).toEqual([]);
  });

  it('isolates different pubkeys', async () => {
    const { store } = setup();
    await store.create('alice', 'a');
    await store.create('bob', 'b');
    expect(await store.listByPubkey('alice')).toHaveLength(1);
    expect(await store.listByPubkey('bob')).toHaveLength(1);
  });
});

describe('ApiKeyStore.revoke', () => {
  it('removes the record and unindexes from the owner list', async () => {
    const { store } = setup();
    const { record } = await store.create('pub', 'k');
    expect(await store.revoke('pub', record.hash)).toBe(true);
    expect(await store.listByPubkey('pub')).toHaveLength(0);
  });

  it('returns false when the hash does not exist', async () => {
    const { store } = setup();
    expect(await store.revoke('pub', 'nohash')).toBe(false);
  });

  it('refuses to let one pubkey revoke another pubkey’s key', async () => {
    const { store } = setup();
    const { record } = await store.create('alice', 'k');
    expect(await store.revoke('mallory', record.hash)).toBe(false);
    expect(await store.listByPubkey('alice')).toHaveLength(1);
  });
});

describe('ApiKeyStore.touch', () => {
  it('updates lastUsedAt on first touch', async () => {
    const { store } = setup();
    const { record } = await store.create('pub', 'k');
    expect(record.lastUsedAt).toBe(0);
    await store.touch(record.hash);
    const updated = (await store.listByPubkey('pub'))[0]!;
    expect(updated.lastUsedAt).toBeGreaterThan(0);
  });

  it('coalesces writes (no-op if touched in the last 60s)', async () => {
    const { store } = setup();
    const { record } = await store.create('pub', 'k');
    await store.touch(record.hash);
    const first = (await store.listByPubkey('pub'))[0]!.lastUsedAt;
    // Second touch immediately — should be a no-op.
    await store.touch(record.hash);
    const second = (await store.listByPubkey('pub'))[0]!.lastUsedAt;
    expect(second).toBe(first);
  });

  it('silently no-ops on unknown hash', async () => {
    const { store } = setup();
    await expect(store.touch('ghost')).resolves.toBeUndefined();
  });
});
