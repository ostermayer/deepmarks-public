// Regression guards for PRIV-F1 / SYNC-F2 (2026-06 review) and the
// per-item migration that closed the whole class on the write path:
//
// History: every private save/edit/delete used to fetch → decrypt →
// rewrite the COMPLETE chunked set, so an undecryptable chunk or a
// stale local cache could erase or resurrect bookmarks relay-wide.
// Round 1 added guards; the per-item migration removed the rewrite —
// saves/edits publish ONE replaceable event keyed by the URL hash and
// deletes publish only their tombstone. The only remaining whole-set
// rewrite is the bulk importer, which keeps the decrypt-failure guard.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/nostr/ndk.js', () => ({
  getNdk: vi.fn(),
  ensureRelayUrlsConnected: vi.fn(),
}));

import {
  addToPrivateSet,
  assertPrivateSetRewriteSafe,
  fetchOwnPrivateSet,
  removeFromPrivateSet,
  updatePrivateSetEntry,
  privateItemSetNameForUrl,
} from '$lib/nostr/private-bookmarks.js';
import { getNdk } from '$lib/nostr/ndk.js';
import { KIND } from '$lib/nostr/kinds.js';
import type { SignedEventLike } from '$lib/nostr/bookmarks.js';

const mockedGetNdk = getNdk as unknown as ReturnType<typeof vi.fn>;

const OWNER = 'f'.repeat(64);
const URL = 'https://new.example.com/page';

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

function installNdk(opts: { decrypt?: (ciphertext: string) => string } = {}) {
  const encryptedPlaintexts: string[] = [];
  const fetchEvents = vi.fn(async () => new Set([chunkEvent()]));
  mockedGetNdk.mockReturnValue({
    signer: {
      decrypt: vi.fn(async (_u: unknown, ciphertext: string) => {
        if (!opts.decrypt) throw new Error('decrypt unavailable');
        return opts.decrypt(ciphertext);
      }),
      encrypt: vi.fn(async (_u: unknown, plaintext: string) => {
        encryptedPlaintexts.push(plaintext);
        return `enc(${encryptedPlaintexts.length})`;
      }),
    },
    getUser: ({ pubkey }: { pubkey: string }) => ({ pubkey }),
    fetchEvents,
  });
  return { encryptedPlaintexts, fetchEvents };
}

beforeEach(() => {
  mockedGetNdk.mockReset();
});

describe('per-item private writes never touch the existing set', () => {
  it('a save publishes one per-item event without fetching or decrypting chunks', async () => {
    const { encryptedPlaintexts, fetchEvents } = installNdk(); // decrypt would THROW if called

    const { templates } = await addToPrivateSet({ url: URL, title: 'new' }, OWNER);

    expect(fetchEvents).not.toHaveBeenCalled();
    expect(templates).toHaveLength(1);
    expect(templates[0]!.tags.find((t) => t[0] === 'd')?.[1])
      .toBe(await privateItemSetNameForUrl(URL));
    expect(templates[0]!.tags.some((t) => t[0] === 'dm-set-version')).toBe(false);
    // The encrypted payload contains exactly this URL's entry.
    expect(encryptedPlaintexts).toHaveLength(1);
    expect(encryptedPlaintexts[0]).toContain(URL);
  });

  it('an edit publishes one per-item event for the same d-tag', async () => {
    installNdk();
    const { templates } = await updatePrivateSetEntry({ url: URL, title: 'edited' }, OWNER);

    expect(templates).toHaveLength(1);
    expect(templates[0]!.tags.find((t) => t[0] === 'd')?.[1])
      .toBe(await privateItemSetNameForUrl(URL));
  });

  it('a delete publishes only the tombstone item', async () => {
    const { encryptedPlaintexts, fetchEvents } = installNdk();
    const { templates, removed } = await removeFromPrivateSet(URL, OWNER);

    expect(fetchEvents).not.toHaveBeenCalled();
    expect(removed).toBe(true);
    expect(templates).toHaveLength(1);
    expect(encryptedPlaintexts[0]).toBe(JSON.stringify([[['d', URL], ['deleted', '1']]]));
  });
});

describe('the bulk importer (last whole-set rewrite) stays guarded', () => {
  it('fetchOwnPrivateSet surfaces decrypt failures for the import guard', async () => {
    installNdk(); // decrypt throws → failure surfaced

    const set = await fetchOwnPrivateSet(OWNER);

    expect(set.decryptFailures).toBeGreaterThan(0);
    expect(() => assertPrivateSetRewriteSafe(set)).toThrow(/not rewriting the set/);
  });

  it('a clean fetch passes the guard and honors tombstones (SYNC-F2 read side)', async () => {
    const DELETED = 'https://deleted.example.com/';
    mockedGetNdk.mockReturnValue({
      signer: {
        decrypt: vi.fn(async (_u: unknown, ciphertext: string) =>
          ciphertext === 'TOMB'
            ? JSON.stringify([[['d', DELETED], ['deleted', '1']]])
            : JSON.stringify([[['d', 'https://kept.example.com/'], ['title', 'kept']]])),
        encrypt: vi.fn(async () => 'CIPHERTEXT'),
      },
      getUser: ({ pubkey }: { pubkey: string }) => ({ pubkey }),
      fetchEvents: vi.fn(async () => new Set([
        chunkEvent(),
        {
          id: 'e'.repeat(64),
          kind: KIND.privateBookmarkSet,
          pubkey: OWNER,
          created_at: 2_000,
          tags: [['d', `deepmarks-private-item:${'a'.repeat(64)}`]],
          content: 'TOMB',
        },
      ])),
    });

    const set = await fetchOwnPrivateSet(OWNER);

    expect(() => assertPrivateSetRewriteSafe(set)).not.toThrow();
    const urls = set.entries.map((entry) => entry.find((t) => t[0] === 'd')?.[1]);
    expect(urls).toContain('https://kept.example.com/');
    expect(urls).not.toContain(DELETED);
    expect(set.deletedUrls?.[DELETED]).toBe(2_000);
  });
});
