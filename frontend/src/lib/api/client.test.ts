import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// purchaseArchive now NIP-98-gates its POST so the per-pubkey rate
// limit on the server can't be dodged by rotating body.userPubkey.
// Mock the NDK signer + NDKEvent so buildNip98AuthHeader doesn't try
// to open relays or use a real crypto path. Same shape as keys.test.ts.
vi.mock('$lib/nostr/ndk', () => ({
  getNdk: () => ({ signer: { async sign() { /* no-op */ } } }),
}));
vi.mock('@nostr-dev-kit/ndk', () => ({
  NDKEvent: class {
    kind: number; created_at: number; tags: string[][]; content: string;
    constructor(_ndk: unknown, init: { kind: number; created_at: number; tags: string[][]; content: string }) {
      this.kind = init.kind;
      this.created_at = init.created_at;
      this.tags = init.tags;
      this.content = init.content;
    }
    async sign() { /* no-op */ }
    rawEvent() {
      return { kind: this.kind, created_at: this.created_at, tags: this.tags, content: this.content, pubkey: 'fakepub', id: 'fakeid', sig: 'fakesig' };
    }
  },
}));

import { api, ApiError, ApiValidationError } from './client.js';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  });
}

describe('api.metadata', () => {
  it('returns parsed metadata on success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ url: 'https://x', title: 'X' })
    );
    const meta = await api.metadata('https://x');
    expect(meta).toEqual({ url: 'https://x', title: 'X' });
  });

  it('encodes the URL parameter', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ url: 'https://x?a=b' }));
    await api.metadata('https://x?a=b');
    const calledUrl = fetchMock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain('url=https%3A%2F%2Fx%3Fa%3Db');
  });

  it('throws ApiError on non-2xx', async () => {
    fetchMock.mockResolvedValue(new Response('oops', { status: 500, statusText: 'ISE' }));
    await expect(api.metadata('https://x')).rejects.toThrow(ApiError);
  });

  it('throws ApiError on malformed JSON', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));
    await expect(api.metadata('https://x')).rejects.toThrow(/Malformed JSON/);
  });

  it('throws ApiValidationError when the response shape is wrong', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ wrong: 'shape' }));
    await expect(api.metadata('https://x')).rejects.toThrow(ApiValidationError);
  });
});

describe('api.purchaseArchive', () => {
  it('POSTs the body and parses the invoice response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        invoice: 'lnbc1...',
        paymentHash: 'hash',
        jobId: 'job-1',
        amountSats: 500
      })
    );
    const out = await api.purchaseArchive({
      url: 'https://x',
      tier: 'private',
      pubkey: 'p'
    });
    expect(out.amountSats).toBe(500);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    // NIP-98 auth header is now required
    expect(((init.headers ?? {}) as Record<string, string>)['Authorization']).toMatch(/^Nostr /);
    expect(JSON.parse(String(init.body))).toEqual({
      url: 'https://x',
      tier: 'private',
      pubkey: 'p'
    });
  });
});

describe('api.archiveStatus', () => {
  it('rejects unknown state strings (zod enum guards the union)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ jobId: 'job-1', state: 'pondering' })
    );
    await expect(api.archiveStatus('job-1')).rejects.toThrow(ApiValidationError);
  });

  it('accepts every documented state', async () => {
    for (const state of [
      'pending-payment',
      'queued',
      'archiving',
      'mirroring',
      'done',
      'failed'
    ] as const) {
      fetchMock.mockResolvedValue(jsonResponse({ jobId: 'j', state }));
      const out = await api.archiveStatus('j');
      expect(out.state).toBe(state);
    }
  });
});

describe('api.searchPublic', () => {
  it('builds the query string from limit/offset', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ hits: [], total: 0 }));
    await api.searchPublic('bitcoin', { limit: 25, offset: 50 });
    const calledUrl = fetchMock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain('q=bitcoin');
    expect(calledUrl).toContain('limit=25');
    expect(calledUrl).toContain('offset=50');
  });
});
