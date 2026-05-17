import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the NDK getter so buildNip98AuthHeader doesn't try to open relays.
const fakeSigner = {
  async sign() { /* no-op */ }
};
const fakeNdk = {
  signer: fakeSigner
};
vi.mock('$lib/nostr/ndk', () => ({
  getNdk: () => fakeNdk
}));

// Mock NDKEvent so we don't need a real crypto path.
vi.mock('@nostr-dev-kit/ndk', () => {
  return {
    NDKEvent: class {
      kind: number;
      created_at: number;
      tags: string[][];
      content: string;
      constructor(_ndk: unknown, init: { kind: number; created_at: number; tags: string[][]; content: string }) {
        this.kind = init.kind;
        this.created_at = init.created_at;
        this.tags = init.tags;
        this.content = init.content;
      }
      async sign() { /* no-op */ }
      rawEvent() {
        return {
          kind: this.kind,
          created_at: this.created_at,
          tags: this.tags,
          content: this.content,
          pubkey: 'fakepub',
          id: 'fakeid',
          sig: 'fakesig'
        };
      }
    }
  };
});

import { api, ApiError, ApiValidationError, buildNip98AuthHeader } from './client.js';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // NDK signer present by default.
  fakeNdk.signer = fakeSigner;
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

describe('buildNip98AuthHeader', () => {
  it('returns `Nostr <base64-json>` and round-trips back to the signed event', async () => {
    const header = await buildNip98AuthHeader('https://x/api/v1/keys', 'POST');
    expect(header).toMatch(/^Nostr [A-Za-z0-9+/=]+$/);
    const json = typeof atob === 'function'
      ? decodeURIComponent(escape(atob(header.slice('Nostr '.length))))
      : Buffer.from(header.slice('Nostr '.length), 'base64').toString('utf8');
    const event = JSON.parse(json) as { kind: number; tags: string[][] };
    expect(event.kind).toBe(27235);
    expect(event.tags.find((t) => t[0] === 'u')?.[1]).toBe('https://x/api/v1/keys');
    expect(event.tags.find((t) => t[0] === 'method')?.[1]).toBe('POST');
  });

  it('uppercases the method tag to match NIP-98 expectation', async () => {
    const header = await buildNip98AuthHeader('https://x', 'get');
    const event = JSON.parse(Buffer.from(header.slice('Nostr '.length), 'base64').toString('utf8')) as {
      tags: string[][];
    };
    expect(event.tags.find((t) => t[0] === 'method')?.[1]).toBe('GET');
  });

  it('throws when no signer is attached', async () => {
    fakeNdk.signer = null as never;
    await expect(buildNip98AuthHeader('https://x', 'GET')).rejects.toThrow(/signer required/i);
  });

  it('round-trips non-ASCII content through UTF-8 safe base64', async () => {
    // The legacy unescape/encodeURIComponent trick mis-handled emoji. Guard
    // against regression by stuffing a multibyte URL into the u-tag.
    const url = 'https://example.com/🌍?q=café';
    const header = await buildNip98AuthHeader(url, 'GET');
    const b64 = header.slice('Nostr '.length);
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const event = JSON.parse(json) as { tags: string[][] };
    expect(event.tags.find((t) => t[0] === 'u')?.[1]).toBe(url);
  });
});

describe('api.keys.create', () => {
  it('POSTs with NIP-98 auth header and parses the create response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        key: 'dmk_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        id: 'hash',
        label: 'laptop',
        createdAt: 1
      }, { status: 201 })
    );
    const result = await api.keys.create('laptop');
    expect(result.key).toMatch(/^dmk_live_/);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Nostr /);
    expect(JSON.parse(String(init.body))).toEqual({ label: 'laptop' });
  });

  it('defaults label to "unnamed" when omitted', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ key: 'dmk_live_x', id: 'h', label: 'unnamed', createdAt: 1 }, { status: 201 })
    );
    await api.keys.create();
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.label).toBe('unnamed');
  });

  it('propagates 402 as an ApiError so the UI can render the upgrade nudge', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'lifetime only' }), { status: 402 })
    );
    await expect(api.keys.create()).rejects.toMatchObject({ status: 402 });
  });

  it('validates the response shape with zod', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ unexpected: true }, { status: 201 }));
    await expect(api.keys.create()).rejects.toThrow(ApiValidationError);
  });
});

describe('api.keys.list', () => {
  it('flattens the {keys: [...]} envelope to a plain array', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        keys: [
          { id: 'a', label: 'laptop', createdAt: 1, lastUsedAt: 0 },
          { id: 'b', label: 'script', createdAt: 2, lastUsedAt: 1_700_000_100 }
        ]
      })
    );
    const list = await api.keys.list();
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe('a');
    expect(list[1]?.lastUsedAt).toBe(1_700_000_100);
  });

  it('sends a GET with NIP-98 auth', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ keys: [] }));
    await api.keys.list();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBeUndefined(); // GET is the default
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Nostr /);
  });
});

describe('api.keys.revoke', () => {
  it('DELETEs the /:id route and succeeds on {ok:true}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await api.keys.revoke('abc123');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/api\/v1\/keys\/abc123$/);
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('raises ApiError on 404 (unknown id)', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    );
    await expect(api.keys.revoke('ghost')).rejects.toBeInstanceOf(ApiError);
  });
});
