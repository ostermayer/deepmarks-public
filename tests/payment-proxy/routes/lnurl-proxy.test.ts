import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { register } from '@src/routes/lnurl.js';
import type { Deps } from '@src/route-deps.js';

const PUBKEY = 'a'.repeat(64);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function makeApp(fetchImpl: typeof fetch) {
  vi.stubGlobal('fetch', fetchImpl);
  const app = Fastify();
  register({
    app,
    lnd: null,
    zaps: { create: vi.fn() },
    rateLimit: vi.fn(async () => ({ ok: true })),
    lnIdentities: { zap: { pubkey: PUBKEY } },
    PUBLIC_BASE_URL: 'https://api.deepmarks.test',
    LN_DOMAIN: 'deepmarks.test',
  } as unknown as Deps);
  await app.ready();
  return app;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('external LNURL proxy routes', () => {
  it('resolves public LNURL-pay metadata', async () => {
    const fetchMock = vi.fn(async () => json({
      callback: 'https://wallet.example/callback',
      minSendable: 1_000,
      maxSendable: 1_000_000,
      metadata: '[["text/plain","zap"]]',
      tag: 'payRequest',
      allowsNostr: true,
      nostrPubkey: PUBKEY,
    }));
    const app = await makeApp(fetchMock as unknown as typeof fetch);

    const res = await app.inject('/lnurl/resolve?payUrl=https%3A%2F%2Fwallet.example%2F.well-known%2Flnurlp%2Falice');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      payUrl: 'https://wallet.example/.well-known/lnurlp/alice',
      meta: {
        callback: 'https://wallet.example/callback',
        allowsNostr: true,
        nostrPubkey: PUBKEY,
      },
    });
  });

  it('rejects private/internal LNURL targets', async () => {
    const app = await makeApp(vi.fn() as unknown as typeof fetch);

    const res = await app.inject('/lnurl/resolve?payUrl=https%3A%2F%2F127.0.0.1%2Flnurlp%2Falice');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('private') });
  });

  it('creates a proxied zap invoice without receiving wallet secrets', async () => {
    const zapRequest = JSON.stringify({
      kind: 9734,
      pubkey: 'b'.repeat(64),
      created_at: 1,
      tags: [['p', PUBKEY], ['amount', '21000']],
      content: '',
      id: 'c'.repeat(64),
      sig: 'd'.repeat(128),
    });
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      if (url.pathname === '/.well-known/lnurlp/alice') {
        return json({
          callback: 'https://wallet.example/callback',
          minSendable: 1_000,
          maxSendable: 1_000_000,
          metadata: '[["text/plain","zap"]]',
          tag: 'payRequest',
          allowsNostr: true,
          nostrPubkey: PUBKEY,
        });
      }
      expect(url.origin).toBe('https://wallet.example');
      expect(url.pathname).toBe('/callback');
      expect(url.searchParams.get('amount')).toBe('21000');
      expect(url.searchParams.get('nostr')).toBe(zapRequest);
      expect(url.searchParams.get('lnurl')).toMatch(/^lnurl1/i);
      return json({ pr: 'lnbc1invoice' });
    });
    const app = await makeApp(fetchMock as unknown as typeof fetch);

    const res = await app.inject({
      method: 'POST',
      url: '/lnurl/zap-invoice',
      payload: {
        payUrl: 'https://wallet.example/.well-known/lnurlp/alice',
        amount: 21_000,
        nostr: zapRequest,
        lnurl: 'lnurl1dp68gurn8ghj7mrww4exctnrdakj7mrww4exctnrdakj7',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pr: 'lnbc1invoice' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
