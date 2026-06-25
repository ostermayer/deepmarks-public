// Regression guards for the strfry writePolicy plugin
// (deploy/box-a/strfry/deepmarks.js), audit findings SYNC-F10 / RELAY-F1
// (2026-06 review). The plugin is driven as a real subprocess over its
// stdin/stdout line protocol, exactly as strfry runs it. ioredis is not
// resolvable from deploy/, so the registry gate fails open (accept) and the
// in-memory rate limiter is what we exercise; limits are shrunk via env so
// the tests stay fast.
//
// FIXED: deepmarks-private-item: tombstones now share the private-state
// budget — all four tests are permanent guards.

import { afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const PLUGIN = fileURLToPath(
  new URL('../../../deploy/box-a/strfry/deepmarks.js', import.meta.url),
);

const GENERAL_LIMIT = 5;
const BOOKMARK_LIMIT = 8;
const children: ChildProcessWithoutNullStreams[] = [];

interface PolicyResponse {
  id: string;
  action: string;
  msg?: string;
}

function startPlugin(): {
  send: (events: object[]) => Promise<PolicyResponse[]>;
} {
  const child = spawn(process.execPath, [PLUGIN], {
    env: {
      ...process.env,
      DEEPMARKS_ADMIN_PUBKEY: 'a'.repeat(64),
      DEEPMARKS_PUBLIC_BRAND_PUBKEY: 'b'.repeat(64),
      STRFRY_RATE_LIMIT_PER_HOUR: String(GENERAL_LIMIT),
      STRFRY_BOOKMARK_RATE_LIMIT_PER_HOUR: String(BOOKMARK_LIMIT),
      STRFRY_PRIVATE_STATE_RATE_LIMIT_PER_HOUR: '100',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);

  const responses: PolicyResponse[] = [];
  const waiters: Array<{ count: number; resolve: (r: PolicyResponse[]) => void }> = [];
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    responses.push(JSON.parse(line) as PolicyResponse);
    for (const waiter of [...waiters]) {
      if (responses.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve([...responses]);
      }
    }
  });

  return {
    send: (events) => {
      const expected = responses.length + events.length;
      const done = new Promise<PolicyResponse[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('plugin response timeout')), 8_000);
        waiters.push({
          count: expected,
          resolve: (r) => {
            clearTimeout(timer);
            resolve(r);
          },
        });
      });
      for (const event of events) {
        child.stdin.write(`${JSON.stringify({ type: 'new', event })}\n`);
      }
      return done;
    },
  };
}

afterAll(() => {
  for (const child of children) child.kill();
});

let nextId = 0;
function event(pubkey: string, kind: number, dTag: string): object {
  nextId += 1;
  return {
    id: nextId.toString(16).padStart(64, '0'),
    kind,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', dTag]],
    content: '',
    sig: 'f'.repeat(128),
  };
}

function pubkeyFor(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

describe('writePolicy rate-limit scopes', () => {
  it('private chunk rewrites get the private-state budget, not the general one (baseline)', async () => {
    const plugin = startPlugin();
    const author = pubkeyFor('1');
    // One whole-set rewrite touches every chunk; more chunks than the
    // general hourly budget must still be accepted in one go.
    const chunks = ['deepmarks-private', ...Array.from({ length: GENERAL_LIMIT + 2 }, (_, i) => `deepmarks-private-${i + 1}`)];
    const responses = await plugin.send(chunks.map((d) => event(author, 30003, d)));

    expect(responses.map((r) => r.action)).toEqual(chunks.map(() => 'accept'));
  });

  it('archive-key chunk rewrites get the private-state budget (baseline)', async () => {
    const plugin = startPlugin();
    const author = pubkeyFor('2');
    const chunks = ['deepmarks-archive-keys', ...Array.from({ length: GENERAL_LIMIT + 2 }, (_, i) => `deepmarks-archive-keys-${i + 1}`)];
    const responses = await plugin.send(chunks.map((d) => event(author, 30003, d)));

    expect(responses.map((r) => r.action)).toEqual(chunks.map(() => 'accept'));
  });

  // RELAY-F1 fix: kind:39701 now has its own (larger, env-tunable)
  // bookmarks budget so a first-run import isn't strangled by the small
  // general bucket — but it is still bounded per pubkey.
  it('kind:39701 bookmarks use the dedicated bookmarks budget, still bounded', async () => {
    const plugin = startPlugin();
    const author = pubkeyFor('3');
    const responses = await plugin.send(
      Array.from({ length: BOOKMARK_LIMIT + 1 }, (_, i) =>
        event(author, 39701, `https://example.com/${i}`),
      ),
    );

    // More than the general limit are accepted (dedicated scope)…
    expect(responses.slice(0, BOOKMARK_LIMIT).every((r) => r.action === 'accept')).toBe(true);
    // …but the bookmarks budget itself still caps abuse.
    expect(responses[BOOKMARK_LIMIT]!.action).toBe('reject');
    expect(responses[BOOKMARK_LIMIT]!.msg).toMatch(/rate limit/);
  });

  it('the general per-pubkey limit still applies to non-bookmark kinds (baseline)', async () => {
    const plugin = startPlugin();
    const author = pubkeyFor('5');
    const responses = await plugin.send(
      Array.from({ length: GENERAL_LIMIT + 1 }, (_, i) =>
        event(author, 10003, `list-${i}`),
      ),
    );

    expect(responses.slice(0, GENERAL_LIMIT).every((r) => r.action === 'accept')).toBe(true);
    expect(responses[GENERAL_LIMIT]!.action).toBe('reject');
    expect(responses[GENERAL_LIMIT]!.msg).toMatch(/rate limit/);
  });

  // Per-item delete tombstones (d = deepmarks-private-item:<hash>) are
  // part of the same private-state machinery as the chunks — the web and
  // mobile clients publish one per deleted bookmark. In the general
  // bucket a bulk cleanup lost tombstones, which is what let deleted
  // private bookmarks resurrect from stale devices (SYNC-F2/F10).
  it('private-item tombstones get the private-state budget too', async () => {
    const plugin = startPlugin();
    const author = pubkeyFor('4');
    const tombstones = Array.from({ length: GENERAL_LIMIT + 2 }, (_, i) =>
      event(author, 30003, `deepmarks-private-item:${String(i).repeat(64).slice(0, 64)}`),
    );
    const responses = await plugin.send(tombstones);

    expect(responses.map((r) => r.action)).toEqual(tombstones.map(() => 'accept'));
  });

  it('private collection rewrites get the private-state budget too', async () => {
    const plugin = startPlugin();
    const author = pubkeyFor('6');
    const collections = Array.from({ length: GENERAL_LIMIT + 2 }, (_, i) =>
      event(author, 30003, `deepmarks-collection-private:${String(i).repeat(64).slice(0, 64)}`),
    );
    const responses = await plugin.send(collections);

    expect(responses.map((r) => r.action)).toEqual(collections.map(() => 'accept'));
  });
});
