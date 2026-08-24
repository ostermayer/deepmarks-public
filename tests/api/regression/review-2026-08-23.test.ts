import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

// Regression guards for the 2026-08-23 full-codebase review, findings 1-4.

// #1 needs getInvoice to fail while the rest of the btcpay module stays real.
vi.mock('@src/btcpay.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@src/btcpay.js')>();
  return { ...real, getInvoice: vi.fn(async () => { throw new Error('btcpay re-read timed out'); }) };
});

import { registerRawJsonBodyParser } from '@src/json-body-parser.js';
import { register as registerLifetimeRoutes } from '@src/routes/lifetime.js';
import { BTCPAY_SETTLED } from '@src/btcpay.js';
import { MeilisearchClient } from '@src/search.js';
import { SaveCountTracker } from '@src/workers/save-count-tracker.js';
import { ZapReceiptListener } from '@src/workers/zap-listener.js';
import { createRelayPool } from '@src/nostr.js';
import { BlocklistStore, DELISTED_EVENTS } from '@src/blocklist.js';
import type { Deps } from '@src/route-deps.js';
import type { Redis } from 'ioredis';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('review #1 — BTCPay webhook returns 5xx on processing failure', () => {
  it('answers 500 and alerts when the settlement re-read throws, so BTCPay redelivers', async () => {
    // Old behavior: a blanket catch returned 200 on ANY exception — a
    // transient getInvoice() failure BEFORE markPaid dropped a PAID
    // settlement forever, silently.
    const app = Fastify({ logger: false });
    registerRawJsonBodyParser(app);
    const alert = vi.fn(async () => {});
    registerLifetimeRoutes({
      app,
      btcPay: { baseUrl: 'https://btcpay.test', apiKey: 'k', storeId: 's', webhookSecret: 'whsec' },
      alerter: { alert },
      lifetimeStore: { getPending: vi.fn(), markPaid: vi.fn(), clearPending: vi.fn() },
      purchases: { get: vi.fn() },
      mediaArchiveAddonStore: { getPending: vi.fn(), markPaid: vi.fn(), clearPending: vi.fn() },
      redis: { set: vi.fn(async () => 'OK') },
      signers: {},
      relayPool: {},
      requireNip98: vi.fn(),
      PUBLIC_BASE_URL: 'https://api.deepmarks.test',
      LIFETIME_LABEL_RELAYS: [],
    } as unknown as Deps);
    await app.ready();

    const payload = JSON.stringify({ type: BTCPAY_SETTLED, invoiceId: 'inv-123' });
    const sig = `sha256=${createHmac('sha256', 'whsec').update(payload).digest('hex')}`;
    const res = await app.inject({
      method: 'POST',
      url: '/btcpay/webhook',
      headers: { 'content-type': 'application/json', 'btcpay-sig': sig },
      payload,
    });

    expect(res.statusCode).toBe(500);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]![0]).toMatchObject({ severity: 'critical', key: 'btcpay-webhook-error' });
    await app.close();
  });
});

describe('review #2 — counter flushes must not REPLACE indexed documents', () => {
  it('MeilisearchClient.updateBatch issues PUT (partial merge); upsertBatch stays POST (replace)', async () => {
    const calls: Array<{ method?: string; url: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method, url: String(url) });
      return new Response('{}', { status: 202, headers: { 'content-type': 'application/json' } });
    }));
    const meili = new MeilisearchClient('http://meili.test', 'master');

    await meili.updateBatch([{ id: 'ev1', save_count: 3 }]);
    await meili.upsertBatch([{ id: 'ev1' } as never]);

    expect(calls[0]).toMatchObject({ method: 'PUT' });
    expect(calls[0]!.url).toContain('/documents');
    expect(calls[1]).toMatchObject({ method: 'POST' });
  });

  it('save-count and zap flushes call updateBatch, never upsertBatch', async () => {
    // The old code flushed {id, counter} stubs through upsertBatch
    // (POST = full-document replace), wiping title/url/tags from the
    // indexed bookmark on every save/zap.
    const meili = { updateBatch: vi.fn(async () => {}), upsertBatch: vi.fn(async () => {}) };
    const logger = { info: vi.fn(), error: vi.fn() };

    const tracker = new SaveCountTracker({ redis: {}, meili, relayUrl: 'wss://r', logger } as never);
    (tracker as unknown as { dirty: Map<string, number> }).dirty.set('ev1', 4);
    await (tracker as unknown as { flush(): Promise<void> }).flush();

    const zap = new ZapReceiptListener({
      redis: { hmget: vi.fn(async () => ['21']) },
      meili,
      relayUrl: 'wss://r',
      trustedReceiptIssuers: new Set<string>(),
      logger,
    } as never);
    (zap as unknown as { dirty: Set<string> }).dirty.add('ev2');
    await (zap as unknown as { flush(): Promise<void> }).flush();

    expect(meili.updateBatch).toHaveBeenCalledTimes(2);
    expect(meili.updateBatch).toHaveBeenNthCalledWith(1, [{ id: 'ev1', save_count: 4 }]);
    expect(meili.updateBatch).toHaveBeenNthCalledWith(2, [{ id: 'ev2', zap_total: 21 }]);
    expect(meili.upsertBatch).not.toHaveBeenCalled();
  });
});

describe('review #3 — worker relay pools reconnect and resubscribe', () => {
  it('createRelayPool enables reconnect + ping (nostr-tools defaults are OFF)', () => {
    // Without enableReconnect a hard relay close runs
    // closeAllSubscriptions and nothing ever resubscribes — a strfry
    // restart silently killed every worker subscription until the
    // container restarted.
    const pool = createRelayPool() as unknown as { enableReconnect: boolean; enablePing: boolean };
    expect(pool.enableReconnect).toBe(true);
    expect(pool.enablePing).toBe(true);
  });
});

describe('review #8 — attribution hiding and popularity dedupe use canonical URLs', () => {
  const mark = (pubkey: string, url: string, id = 'e1'): never => ({
    id, pubkey, url, title: '', description: '', tags: [],
    archivedForever: false, savedAt: 100,
  }) as never;

  it('hides a seeded mark when a real user saved a ?utm_/-slash variant of the URL', async () => {
    const { applyAttributionPreference } = await import('@src/feed/routes.js');
    const seeder = 's'.repeat(64);
    const user = 'u'.repeat(64);
    const out = applyAttributionPreference(
      [
        mark(seeder, 'https://example.com/article', 'seeded'),
        mark(user, 'https://example.com/article/?utm_source=x', 'real'),
      ],
      new Set([seeder]),
    );
    // Raw string compare used to keep the seeded copy visible —
    // violating the documented attribution rule.
    expect((out as Array<{ id: string }>).map((b) => b.id)).toEqual(['real']);
  });

  it('groups popularity across URL variants of the same page', async () => {
    const { rankByPopularity } = await import('@src/feed/rank.js');
    const ranked = rankByPopularity([
      mark('a'.repeat(64), 'https://example.com/page'),
      mark('b'.repeat(64), 'https://example.com/page/'),
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.saveCount).toBe(2);
  });
});

describe('review #11 — fanout rate-limit counter is created atomically with its TTL', () => {
  async function makeLimiter(redis: Record<string, unknown>) {
    const { RelayFanoutWorker } = await import('@src/workers/relay-fanout.js');
    const w = Object.create(RelayFanoutWorker.prototype) as {
      allowFanoutFor(pubkey: string): Promise<boolean>;
    };
    (w as unknown as { deps: { redis: unknown } }).deps = { redis };
    return w;
  }

  it('creates the counter via SET NX EX before INCR', async () => {
    const redis = {
      set: vi.fn(async () => 'OK'),
      incr: vi.fn(async () => 1),
      ttl: vi.fn(async () => 60),
      expire: vi.fn(async () => 1),
    };
    const w = await makeLimiter(redis);
    expect(await w.allowFanoutFor('p'.repeat(64))).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('dm:relay-fanout:rl:'), '0', 'EX', expect.any(Number), 'NX',
    );
    expect(redis.set.mock.invocationCallOrder[0]!).toBeLessThan(redis.incr.mock.invocationCallOrder[0]!);
  });

  it('self-heals a TTL-less counter stranded by the old INCR-then-EXPIRE pattern', async () => {
    const redis = {
      set: vi.fn(async () => null),
      incr: vi.fn(async () => 999_999),
      ttl: vi.fn(async () => -1),
      expire: vi.fn(async () => 1),
    };
    const w = await makeLimiter(redis);
    expect(await w.allowFanoutFor('p'.repeat(64))).toBe(false);
    expect(redis.expire).toHaveBeenCalledWith(expect.stringContaining('dm:relay-fanout:rl:'), expect.any(Number));
  });
});

describe('review #15 — search indexer rejects non-http(s) bookmark URLs', () => {
  it('drops a kind:39701 whose d-tag is a javascript: URL', async () => {
    const { BookmarkIndexer } = await import('@src/search.js');
    const indexer = Object.create(BookmarkIndexer.prototype) as {
      eventToDoc(event: unknown): Promise<unknown>;
    };
    const doc = await (indexer as unknown as { eventToDoc(e: unknown): Promise<unknown> }).eventToDoc({
      id: 'f'.repeat(64),
      kind: 39701,
      pubkey: 'a'.repeat(64),
      created_at: 100,
      content: '',
      sig: '0'.repeat(128),
      tags: [['d', 'javascript:alert(document.domain)'], ['title', 'xss']],
    });
    expect(doc).toBeNull();
  });
});

describe('follow-up — API-key mint gates on the live lifetime store', () => {
  async function makeKeysApp(isPaid: boolean) {
    const { register } = await import('@src/routes/api-v1.js');
    const app = Fastify({ logger: false });
    registerRawJsonBodyParser(app);
    const create = vi.fn(async () => ({
      plaintext: 'dmk_live_test',
      record: { id: 'k1', label: 'test', createdAt: 1, lastUsedAt: null },
    }));
    register({
      app,
      apiKeys: { create },
      lifetimeStore: { isPaid: vi.fn(async () => isPaid) },
      purchases: {},
      relayPool: {},
      redis: {},
      meili: {},
      gateRateLimit: vi.fn(async () => true),
      requireNip98: vi.fn(async () => ({ pubkey: 'a'.repeat(64) })),
      PUBLIC_BASE_URL: 'https://api.deepmarks.test',
      INDEXER_RELAY_URL_FOR_API: 'ws://strfry:7777',
    } as unknown as Deps);
    await app.ready();
    return { app, create };
  }

  it('mints a key for a paid lifetime member', async () => {
    // The old gate read accounts.isLifetimeMember — but the email-account
    // subsystem's create() was never wired, so no account exists and
    // EVERY paid member got 402 here.
    const { app, create } = await makeKeysApp(true);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/keys',
      headers: { 'content-type': 'application/json' },
      payload: '{"label":"ci"}',
    });
    expect(res.statusCode).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('402s a non-lifetime pubkey', async () => {
    const { app, create } = await makeKeysApp(false);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/keys',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(402);
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('review #4 — admin delisting and search filtering share one Redis key', () => {
  it('delistEvent writes the exported DELISTED_EVENTS key the search surfaces read', async () => {
    // Search + api-v1 used to read 'dm:blocked-events', which nothing
    // ever wrote — admin delisting was a no-op for search (takedown
    // bypass). The read sites now import this exact constant.
    expect(DELISTED_EVENTS).toBe('dm:delisted-events');

    const saddKeys: string[] = [];
    const multi = {
      sadd: (key: string) => { saddKeys.push(key); return multi; },
      set: () => multi,
      srem: () => multi,
      del: () => multi,
      exec: async () => [],
    };
    const store = new BlocklistStore({ multi: () => multi } as unknown as Redis);
    await store.delistEvent('E'.repeat(64), 'takedown', 'a'.repeat(64));
    expect(saddKeys).toContain(DELISTED_EVENTS);
  });
});

describe('cleanup follow-up — people-search sources candidates from the live registry', () => {
  it('uses SISMEMBER/SSCAN on dm:registered:pubkeys, never the dead dm:pk:* namespace', async () => {
    const { register } = await import('@src/routes/contacts.js');
    const app = Fastify({ logger: false });
    const target = 'b'.repeat(64);
    const sismember = vi.fn(async () => 1);
    const scanCalls: string[] = [];
    register({
      app,
      redis: {
        sismember,
        sscan: vi.fn(async () => ['0', []]),
        scan: vi.fn(async (...args: string[]) => { scanCalls.push(args.join(' ')); return ['0', []]; }),
        hgetall: vi.fn(async () => ({})),
        mget: vi.fn(async () => []),
        exists: vi.fn(async () => 0),
        get: vi.fn(async () => null),
      },
      gateRateLimit: vi.fn(async () => true),
      requireNip98: vi.fn(async () => ({ pubkey: 'a'.repeat(64) })),
      PUBLIC_BASE_URL: 'https://api.deepmarks.test',
    } as unknown as Deps);
    await app.ready();

    const { nip19 } = await import('nostr-tools');
    const npub = nip19.npubEncode(target);
    const res = await app.inject({ url: `/account/people-search?q=${npub}` });

    expect(res.statusCode).toBe(200);
    expect(sismember).toHaveBeenCalledWith('dm:registered:pubkeys', target);
    expect(res.json().people.some((p: { pubkey: string }) => p.pubkey === target)).toBe(true);
    // The dead email-era namespace must never be consulted.
    expect(scanCalls.join('\n')).not.toContain('dm:pk:');
    await app.close();
  });
});
