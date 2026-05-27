import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Archive/lifetime routes use NIP-98. Mock the NDK signer + NDKEvent so
// buildNip98AuthHeader doesn't try to open relays or use a real crypto path.
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
      jsonResponse({ url: 'https://x', title: 'X', mediaKind: 'video', contentType: 'video/mp4' })
    );
    const meta = await api.metadata('https://x');
    expect(meta).toEqual({ url: 'https://x', title: 'X', mediaKind: 'video', contentType: 'video/mp4' });
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

  it('does not expose raw internal backend JSON on server errors', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"internal error"}', { status: 500, statusText: 'ISE' }));
    await expect(api.metadata('https://x')).rejects.toThrow('Deepmarks had a server problem. Try again in a moment.');
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

describe('api.enqueueLifetimeArchive', () => {
  it('POSTs the body and parses the lifetime enqueue response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        paymentHash: 'hash',
        jobId: 'job-1',
        amountSats: 0
      })
    );
    const out = await api.enqueueLifetimeArchive({
      url: 'https://x',
      tier: 'private',
      archiveKey: 'a'.repeat(43),
      mirrorUrls: ['https://backup.example.com'],
      bookmarkSavedAt: 1_700_000_000,
    });
    expect(out.amountSats).toBe(0);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(((init.headers ?? {}) as Record<string, string>)['Authorization']).toMatch(/^Nostr /);
    expect(JSON.parse(String(init.body))).toEqual({
      url: 'https://x',
      tier: 'private',
      archiveKey: 'a'.repeat(43),
      mirrorUrls: ['https://backup.example.com'],
      bookmarkSavedAt: 1_700_000_000,
    });
  });
});

describe('api.account settings', () => {
  it('defaults missing legacy theme settings to auto', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        updatedAt: 123,
        relays: [{ url: 'wss://relay.example.com', read: true, write: true }],
        defaultTags: ['toread'],
        defaultVisibility: 'private',
        archiveAllByDefault: false,
        archiveDefaultManualOverride: false,
        backupBlossomServers: [],
      }),
    );

    const settings = await api.account.getSettings();
    expect(settings.theme).toBe('auto');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(((init.headers ?? {}) as Record<string, string>)['Authorization']).toMatch(/^Nostr /);
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

describe('api.archives', () => {
  it('paginates the NIP-98 account archive list', async () => {
    const first = {
      jobId: 'job-1',
      url: 'https://a.test',
      blobHash: 'a'.repeat(64),
      tier: 'public',
      archivedAt: 1,
      completedAt: 10,
      bookmarkSavedAt: 1,
    };
    const second = {
      jobId: 'job-2',
      url: 'https://b.test',
      blobHash: 'b'.repeat(64),
      tier: 'private',
      archivedAt: 2,
      completedAt: 20,
      bookmarkSavedAt: 2,
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ archives: [first], count: 1, total: 2 }))
      .mockResolvedValueOnce(jsonResponse({ archives: [second], count: 1, total: 2 }));

    const out = await api.archives.listAll();

    expect(out).toEqual([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toContain('/account/archives?limit=5000&offset=0');
    expect(fetchMock.mock.calls[1]![0]).toContain('/account/archives?limit=5000&offset=5000');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(((init.headers ?? {}) as Record<string, string>)['Authorization']).toMatch(/^Nostr /);
  });
});
