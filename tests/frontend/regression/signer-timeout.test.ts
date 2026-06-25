// Regression guards for audit finding PRIV-F2 (2026-06 review), FIXED:
// NIP-46 remote-signer crypto calls settle only when the bunker replies.
// With no ceiling, a sleeping phone hung the private-bookmark refresh
// forever (and wedged its loading latch), and the bookmarks page showed
// an empty private list with no explanation. Signer decrypt/encrypt now
// time out (SIGNER_OP_TIMEOUT_MS), the failure reason is classified
// (signer-timeout / nip44-unsupported), and rewrites refuse to proceed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/nostr/ndk.js', () => ({
  getNdk: vi.fn(),
  ensureRelayUrlsConnected: vi.fn(),
}));

import {
  addToPrivateSet,
  fetchOwnPrivateSet,
  tryDecryptPrivateSet,
} from '$lib/nostr/private-bookmarks.js';
import { getNdk } from '$lib/nostr/ndk.js';
import { KIND } from '$lib/nostr/kinds.js';
import type { SignedEventLike } from '$lib/nostr/bookmarks.js';

const mockedGetNdk = getNdk as unknown as ReturnType<typeof vi.fn>;
const OWNER = 'f'.repeat(64);

function chunkEvent(): SignedEventLike {
  return {
    id: 'c'.repeat(64),
    kind: KIND.privateBookmarkSet,
    pubkey: OWNER,
    created_at: 1_000,
    tags: [['d', 'deepmarks-private'], ['dm-set-version', 'v1'], ['dm-set-count', '1']],
    content: 'CHUNK',
  };
}

function installNdk(decrypt: () => Promise<string>) {
  mockedGetNdk.mockReturnValue({
    signer: {
      decrypt: vi.fn((_u: unknown, _c: string) => decrypt()),
      encrypt: vi.fn(async () => 'CIPHERTEXT'),
    },
    getUser: ({ pubkey }: { pubkey: string }) => ({ pubkey }),
    fetchEvents: vi.fn(async () => new Set([chunkEvent()])),
  });
}

beforeEach(() => {
  mockedGetNdk.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('hung remote signer', () => {
  it('fetchOwnPrivateSet settles with a signer-timeout failure instead of hanging', async () => {
    installNdk(() => new Promise<string>(() => { /* bunker never replies */ }));

    const pending = fetchOwnPrivateSet(OWNER);
    await vi.advanceTimersByTimeAsync(31_000);
    const set = await pending;

    expect(set.decryptFailures).toBeGreaterThan(0);
    expect(set.decryptFailureReason).toBe('signer-timeout');
    expect(set.entries).toEqual([]);
  });

  it('a save against a hung signer aborts instead of spinning forever', async () => {
    // Per-item saves no longer decrypt anything — the hang risk is the
    // ENCRYPT of the new entry, which carries the same timeout.
    mockedGetNdk.mockReturnValue({
      signer: {
        decrypt: vi.fn(),
        encrypt: vi.fn(() => new Promise<string>(() => { /* bunker never replies */ })),
      },
      getUser: ({ pubkey }: { pubkey: string }) => ({ pubkey }),
      fetchEvents: vi.fn(async () => new Set()),
    });

    const pending = addToPrivateSet({ url: 'https://new.example.com/', title: 'x' }, OWNER);
    pending.catch(() => { /* asserted below — pre-attach so the timeout rejection is handled */ });
    await vi.advanceTimersByTimeAsync(31_000);

    await expect(pending).rejects.toThrow(/timed out/i);
  });
});

describe('signer without nip44 support', () => {
  it('is classified as nip44-unsupported, not wrong-key', async () => {
    installNdk(() => Promise.reject(
      new Error('nip44 encryption is not available from your browser extension'),
    ));

    const result = await tryDecryptPrivateSet(chunkEvent(), OWNER);

    expect(result).toEqual({ ok: false, reason: 'nip44-unsupported' });
  });

  it('still reports plain decrypt errors as wrong-key', async () => {
    installNdk(() => Promise.reject(new Error('invalid MAC')));

    const result = await tryDecryptPrivateSet(chunkEvent(), OWNER);

    expect(result).toEqual({ ok: false, reason: 'wrong-key' });
  });
});
