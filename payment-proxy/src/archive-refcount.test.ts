import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { backfillFromExistingArchives, refsKeyFor } from './archive-refcount.js';

class FakeRedis {
  kv = new Map<string, string>();
  hashes = new Map<string, Record<string, string>>();
  sets = new Map<string, Set<string>>();

  async set(key: string, value: string, mode?: string): Promise<'OK' | null> {
    if (mode === 'NX' && this.kv.has(key)) return null;
    this.kv.set(key, value);
    return 'OK';
  }

  async scan(_cursor: string, _match: string, pattern: string): Promise<[string, string[]]> {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    return ['0', [...this.hashes.keys()].filter((key) => key.startsWith(prefix))];
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.hashes.get(key) ?? {};
  }

  multi() {
    const ops: Array<() => void> = [];
    return {
      sadd: (key: string, value: string) => {
        ops.push(() => {
          const set = this.sets.get(key) ?? new Set<string>();
          set.add(value);
          this.sets.set(key, set);
        });
        return this;
      },
      exec: async () => {
        for (const op of ops) op();
        return [];
      },
    };
  }

  async del(key: string): Promise<number> {
    return this.kv.delete(key) ? 1 : 0;
  }
}

describe('archive refcount backfill', () => {
  it('seeds refs for every file in multi-file archive records', async () => {
    const pubkey = 'a'.repeat(64);
    const htmlHash = 'b'.repeat(64);
    const pdfHash = 'c'.repeat(64);
    const redis = new FakeRedis();
    redis.hashes.set(`dm:archives:${pubkey}`, {
      [htmlHash]: JSON.stringify({
        blobHash: htmlHash,
        files: [
          { role: 'html', blobHash: htmlHash, url: 'https://journal.example/article' },
          { role: 'pdf', blobHash: pdfHash, url: 'https://journal.example/article.pdf' },
        ],
      }),
    });

    await backfillFromExistingArchives(redis as unknown as Redis, { info: () => undefined, warn: () => undefined });

    expect(redis.sets.get(refsKeyFor(htmlHash))).toEqual(new Set([pubkey]));
    expect(redis.sets.get(refsKeyFor(pdfHash))).toEqual(new Set([pubkey]));
  });
});
