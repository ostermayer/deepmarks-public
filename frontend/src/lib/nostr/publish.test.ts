import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnsignedEventTemplate } from './bookmarks.js';

vi.mock('$app/environment', () => ({ browser: true }));

vi.mock('$lib/config.js', () => ({
  config: {
    apiBase: 'https://api.deepmarks.test',
    deepmarksRelay: 'wss://relay.deepmarks.org',
  },
}));

vi.mock('$lib/api/client.js', () => ({
  buildNip98AuthHeader: vi.fn(async () => 'nip98-auth'),
}));

vi.mock('$lib/stores/user-settings', () => ({
  userSettings: {
    subscribe(run: (value: { relays: unknown[] }) => void) {
      run({ relays: [] });
      return () => undefined;
    },
  },
}));

vi.mock('./ndk.js', () => ({
  getNdk: () => ({ signer: {} }),
}));

vi.mock('@nostr-dev-kit/ndk', () => ({
  NDKRelaySet: {
    fromRelayUrls: vi.fn(() => ({})),
  },
  NDKEvent: class {
    id = 'e'.repeat(64);
    sig = 'f'.repeat(128);
    pubkey: string;
    created_at?: number;
    kind?: number;
    tags: string[][];
    content: string;

    constructor(
      _ndk: unknown,
      event: {
        pubkey: string;
        created_at?: number;
        kind?: number;
        tags: string[][];
        content: string;
      },
    ) {
      this.pubkey = event.pubkey;
      this.created_at = event.created_at;
      this.kind = event.kind;
      this.tags = event.tags;
      this.content = event.content;
    }

    async sign(): Promise<void> {
      // The mocked constructor already supplies id/sig.
    }
  },
}));

import { pendingPublishCount } from './pending-publish.js';
import {
  formatPublishHttpError,
  isParameterizedReplaceable,
  publishEventQueued,
  relayUrlsForPublish,
} from './publish.js';

describe('isParameterizedReplaceable', () => {
  it('returns true for kinds in [30000, 40000) with a d-tag', () => {
    expect(
      isParameterizedReplaceable({
        kind: 30003,
        created_at: 0,
        tags: [['d', 'set-name']],
        content: '',
      }),
    ).toBe(true);
    expect(
      isParameterizedReplaceable({
        kind: 39701,
        created_at: 0,
        tags: [['d', 'https://x']],
        content: '',
      }),
    ).toBe(true);
  });

  it('returns false for in-range kinds without a d-tag', () => {
    expect(
      isParameterizedReplaceable({
        kind: 30003,
        created_at: 0,
        tags: [['title', 'oops']],
        content: '',
      }),
    ).toBe(false);
  });

  it('returns false for ephemeral / non-replaceable kinds', () => {
    expect(
      isParameterizedReplaceable({
        kind: 1,
        created_at: 0,
        tags: [['d', 'unused']],
        content: '',
      }),
    ).toBe(false);
    expect(
      isParameterizedReplaceable({
        kind: 9735,
        created_at: 0,
        tags: [],
        content: '',
      }),
    ).toBe(false);
  });

  it('returns false when the d-tag value is missing or non-string', () => {
    expect(
      isParameterizedReplaceable({
        kind: 30003,
        created_at: 0,
        tags: [['d']],
        content: '',
      }),
    ).toBe(false);
  });
});

describe('relayUrlsForPublish', () => {
  it('returns only the Deepmarks relay, regardless of the user relay set', () => {
    const relays = relayUrlsForPublish([
      { url: 'wss://read.example', read: true, write: false },
      { url: 'wss://write.example', read: false, write: true },
      { url: 'wss://relay.deepmarks.org', read: true, write: true },
    ]);
    expect(relays).toEqual(['wss://relay.deepmarks.org']);
  });
});

describe('formatPublishHttpError', () => {
  it('hides raw internal server bodies from user-facing publish errors', () => {
    expect(formatPublishHttpError(500, '{"error":"internal error"}')).toBe(
      'Deepmarks could not sync this bookmark right now. It was saved on this device and will retry automatically.',
    );
  });

  it('explains temporary publish queue failures without exposing raw JSON', () => {
    expect(formatPublishHttpError(503, '{"error":"publish queue temporarily unavailable"}')).toBe(
      'Deepmarks publish queue is temporarily unavailable. This bookmark was saved on this device and will retry automatically.',
    );
  });

  it('keeps useful client-side validation detail without raw JSON', () => {
    expect(formatPublishHttpError(400, '{"error":"missing d tag"}')).toBe(
      'Deepmarks could not publish this bookmark: missing d tag',
    );
  });

  it('uses the caller subject for non-bookmark publishes', () => {
    expect(formatPublishHttpError(500, '{"error":"internal error"}', 'friends list')).toBe(
      'Deepmarks could not sync this friends list right now. It was saved on this device and will retry automatically.',
    );
  });
});

describe('publishEventQueued', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        storage.delete(key);
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns after durable queueing instead of waiting for /publish', async () => {
    const pubkey = 'p'.repeat(64);
    const template: UnsignedEventTemplate = {
      kind: 39701,
      created_at: 1_700_000_000,
      tags: [['d', 'https://queued.example']],
      content: '',
    };

    let resolveFetch: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    const queuedResult = await Promise.race([
      publishEventQueued(template, pubkey),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 25)),
    ]);

    expect(queuedResult).toEqual({ eventId: 'e'.repeat(64), relays: [] });
    expect(pendingPublishCount(pubkey)).toBe(1);

    await waitFor(() => fetchMock.mock.calls.length > 0);
    resolveFetch({
      ok: true,
      status: 202,
      text: async () => '',
    } as Response);
    await waitFor(() => pendingPublishCount(pubkey) === 0);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not met');
}
