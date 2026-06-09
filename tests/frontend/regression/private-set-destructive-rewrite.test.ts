// Regression guards for audit findings PRIV-F1 / SYNC-F2 (2026-06 review):
// the private-bookmark write path rebuilds and republishes the WHOLE
// encrypted kind:30003 set, so anything that feeds it an incomplete view
// of the current set destroys data relay-wide for every device.
//
//   PRIV-F1  fetchOwnPrivateSet silently converts a failed chunk decrypt
//            (remote-signer hiccup, missing nip44, user denied a prompt)
//            into `entries: []`; the next add/edit/delete then republishes
//            the set WITHOUT those entries — erased everywhere.
//   SYNC-F2  withLocalPrivateCacheEntries unions this device's stale
//            localStorage cache back into every rewrite without checking
//            tombstones, resurrecting bookmarks deleted on another device.
//
// Both bugs are FIXED (fetchOwnPrivateSet surfaces decryptFailures +
// deletedUrls; the rewrite paths refuse incomplete views and the cache
// union honors tombstones) — these tests are now permanent guards.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/nostr/ndk.js', () => ({
  getNdk: vi.fn(),
  ensureRelayUrlsConnected: vi.fn(),
}));

import { addToPrivateSet, removeFromPrivateSet } from '$lib/nostr/private-bookmarks.js';
import { getNdk } from '$lib/nostr/ndk.js';
import { KIND } from '$lib/nostr/kinds.js';
import type { SignedEventLike } from '$lib/nostr/bookmarks.js';

const mockedGetNdk = getNdk as unknown as ReturnType<typeof vi.fn>;

const OWNER = 'f'.repeat(64);
const KEPT_URL = 'https://kept.example.com/article';
const DELETED_URL = 'https://deleted-on-other-device.example.com/';
const NEW_URL = 'https://new.example.com/page';

const KEPT_ENTRY = [['d', KEPT_URL], ['title', 'kept']];
const TOMBSTONE_ENTRY = [['d', DELETED_URL], ['deleted', '1']];

function chunkEvent(overrides: Partial<SignedEventLike> = {}): SignedEventLike {
  return {
    id: 'c'.repeat(64),
    kind: KIND.privateBookmarkSet,
    pubkey: OWNER,
    created_at: 1_000,
    tags: [['d', 'deepmarks-private'], ['dm-set-version', 'v1'], ['dm-set-count', '1']],
    content: 'CHUNK',
    ...overrides,
  };
}

function tombstoneEvent(): SignedEventLike {
  return {
    id: 'e'.repeat(64),
    kind: KIND.privateBookmarkSet,
    pubkey: OWNER,
    created_at: 2_000, // newer than the chunk — the delete is the latest word
    tags: [['d', `deepmarks-private-item:${'a'.repeat(64)}`]],
    content: 'TOMB',
  };
}

/** NDK mock whose signer "decrypts" by table lookup and records every
 *  plaintext it is asked to encrypt, so tests can inspect exactly what
 *  would be republished to the relay. */
function installNdk(opts: {
  events: SignedEventLike[];
  decrypt?: (ciphertext: string) => string;
}) {
  const encryptedPlaintexts: string[] = [];
  const signer = {
    decrypt: vi.fn(async (_user: unknown, ciphertext: string) => {
      if (!opts.decrypt) throw new Error('decrypt unavailable');
      return opts.decrypt(ciphertext);
    }),
    encrypt: vi.fn(async (_user: unknown, plaintext: string) => {
      encryptedPlaintexts.push(plaintext);
      return `enc(${encryptedPlaintexts.length})`;
    }),
  };
  mockedGetNdk.mockReturnValue({
    signer,
    getUser: ({ pubkey }: { pubkey: string }) => ({ pubkey }),
    fetchEvents: vi.fn(async () => new Set(opts.events)),
  });
  return { signer, encryptedPlaintexts };
}

beforeEach(() => {
  mockedGetNdk.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PRIV-F1: decrypt failure must not feed a destructive whole-set rewrite', () => {
  it('still merges fetched entries into a save when decryption works (baseline)', async () => {
    const { encryptedPlaintexts } = installNdk({
      events: [chunkEvent()],
      decrypt: () => JSON.stringify([KEPT_ENTRY]),
    });

    await addToPrivateSet({ url: NEW_URL, title: 'new' }, OWNER);

    expect(encryptedPlaintexts).toHaveLength(1);
    expect(encryptedPlaintexts[0]).toContain(KEPT_URL);
    expect(encryptedPlaintexts[0]).toContain(NEW_URL);
  });

  // A failed chunk decrypt would collapse to entries:[] and the
  // republished set would contain ONLY the new bookmark — every other
  // private bookmark erased relay-wide. The rewrite must abort instead.
  it('aborts the save when a fetched chunk cannot be decrypted', async () => {
    installNdk({ events: [chunkEvent()] }); // decrypt always throws

    await expect(addToPrivateSet({ url: NEW_URL, title: 'new' }, OWNER)).rejects.toThrow();
  });

  it('aborts a delete when a fetched chunk cannot be decrypted', async () => {
    installNdk({ events: [chunkEvent()] });

    await expect(removeFromPrivateSet(KEPT_URL, OWNER)).rejects.toThrow();
  });
});

describe('SYNC-F2: stale local cache must not resurrect bookmarks deleted on another device', () => {
  function installLocalStorageCache(urls: string[]) {
    const store = new Map<string, string>([[
      `deepmarks-private-bookmarks:v3:${OWNER}`,
      JSON.stringify(urls.map((url) => ({ url, title: url, tags: [], savedAt: 500 }))),
    ]]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  }

  function installRelayStateWithTombstone() {
    return installNdk({
      events: [chunkEvent(), tombstoneEvent()],
      decrypt: (ciphertext) =>
        ciphertext === 'TOMB'
          ? JSON.stringify([TOMBSTONE_ENTRY])
          : JSON.stringify([KEPT_ENTRY]),
    });
  }

  it('drops the tombstoned URL from the fetched set itself (baseline)', async () => {
    installLocalStorageCache([]); // empty cache — pure relay state
    const { encryptedPlaintexts } = installRelayStateWithTombstone();

    await addToPrivateSet({ url: NEW_URL, title: 'new' }, OWNER);

    expect(encryptedPlaintexts.join('')).toContain(KEPT_URL);
    expect(encryptedPlaintexts.join('')).not.toContain(DELETED_URL);
  });

  // The deleted URL still sits in THIS device's localStorage cache
  // (cached before the other device deleted it). The cache union must
  // consult the newer tombstone instead of re-injecting it — otherwise
  // the next save republishes the deleted bookmark in a fresh chunk
  // whose created_at beats the tombstone and it resurrects everywhere.
  it('does not re-publish a URL covered by a newer delete tombstone', async () => {
    installLocalStorageCache([DELETED_URL]);
    const { encryptedPlaintexts } = installRelayStateWithTombstone();

    await addToPrivateSet({ url: NEW_URL, title: 'new' }, OWNER);

    expect(encryptedPlaintexts.join('')).not.toContain(DELETED_URL);
  });
});
