import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('$lib/nostr/ndk.js', () => ({
  getNdk: vi.fn(),
}));

import {
  extractImportedNoteRefs,
  extractImportedUrls,
  isValidNip51PrivateTags,
  mergeImportedReplacement,
  tryDecryptNip51PrivateTags,
} from '$lib/nostr/imported-bookmarks.js';
import { getNdk } from '$lib/nostr/ndk.js';
import type { SignedEventLike } from '$lib/nostr/bookmarks.js';

const mockedGetNdk = getNdk as unknown as ReturnType<typeof vi.fn>;

function ev(overrides: Partial<SignedEventLike> & { kind: number; tags: string[][] }): SignedEventLike {
  return {
    id: 'ev1',
    pubkey: 'curator',
    created_at: 1_700_000_000,
    content: '',
    ...overrides,
  };
}

function makeNdkMock(decrypt: ReturnType<typeof vi.fn> | null) {
  return {
    signer: decrypt ? { decrypt } : null,
    getUser: ({ pubkey }: { pubkey: string }) => ({ pubkey }),
  };
}

beforeEach(() => {
  mockedGetNdk.mockReset();
});

describe('extractImportedUrls', () => {
  it('returns one bookmark per r-tag on a kind:10003 list', () => {
    const out = extractImportedUrls(
      ev({
        kind: 10003,
        tags: [
          ['r', 'https://example.com/a'],
          ['r', 'https://example.com/b'],
          ['e', 'some-note-id'],
        ],
      }),
    );
    expect(out).toHaveLength(2);
    expect(out.map((b) => b.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('works on kind:30003 parametric-replaceable lists', () => {
    const out = extractImportedUrls(
      ev({
        kind: 30003,
        tags: [
          ['d', 'reading-list'],
          ['r', 'https://example.com'],
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.listKind).toBe(30003);
    expect(out[0]?.listIdentifier).toBe('reading-list');
  });

  it('does not import Deepmarks collection members as loose bookmarks', () => {
    const out = extractImportedUrls(
      ev({
        kind: 30003,
        tags: [
          ['d', 'deepmarks-collection:reading-list'],
          ['r', 'https://example.com/collection-member'],
        ],
      }),
    );
    expect(out).toEqual([]);
  });

  it('works on kind:30001 legacy bookmark sets (deprecated predecessor of 30003)', () => {
    const out = extractImportedUrls(
      ev({
        kind: 30001,
        tags: [
          ['d', 'bookmark'],
          ['r', 'https://legacy.example'],
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.listKind).toBe(30001);
    expect(out[0]?.listIdentifier).toBe('bookmark');
  });

  it('ignores non-list event kinds', () => {
    expect(
      extractImportedUrls(ev({ kind: 39701, tags: [['r', 'https://x']] })),
    ).toEqual([]);
    expect(
      extractImportedUrls(ev({ kind: 1, tags: [['r', 'https://x']] })),
    ).toEqual([]);
  });

  it('skips r-tags that are not http(s) URLs', () => {
    const out = extractImportedUrls(
      ev({
        kind: 10003,
        tags: [
          ['r', 'mailto:foo@bar'],
          ['r', 'magnet:?xt=urn:btih:123'],
          ['r', 'https://ok.example'],
          ['r', ''],
        ],
      }),
    );
    expect(out.map((b) => b.url)).toEqual(['https://ok.example']);
  });

  it('uses tag[2] as title when present, otherwise falls back to the URL', () => {
    const out = extractImportedUrls(
      ev({
        kind: 10003,
        tags: [
          ['r', 'https://a.example'],
          ['r', 'https://b.example', 'B has a title'],
        ],
      }),
    );
    expect(out[0]?.title).toBe('https://a.example');
    expect(out[1]?.title).toBe('B has a title');
  });

  it('carries curator pubkey + list event id through to each record', () => {
    const out = extractImportedUrls(
      ev({
        id: 'LIST_EVENT_ID',
        pubkey: 'alice',
        kind: 10003,
        tags: [['r', 'https://x']],
      }),
    );
    expect(out[0]?.curator).toBe('alice');
    expect(out[0]?.eventId).toBe('LIST_EVENT_ID');
    expect(out[0]?.source).toBe('nip51-list');
    expect(out[0]?.visibility).toBe('public');
  });

  it('uses the event created_at as the initial savedAt fallback', () => {
    const out = extractImportedUrls(
      ev({ kind: 10003, created_at: 1_800_000_000, tags: [['r', 'https://x']] }),
    );
    expect(out[0]?.savedAt).toBe(1_800_000_000);
    expect(out[0]?.eventCreatedAt).toBe(1_800_000_000);
  });

  it('ignores r-tags with non-string values', () => {
    const out = extractImportedUrls(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ev({ kind: 10003, tags: [['r', 42 as any]] }),
    );
    expect(out).toEqual([]);
  });

  it('can extract URLs from decrypted private NIP-51 tag arrays', () => {
    // Mirrors the note-ref private case: a fully-private bookmark list
    // carries zero public tags and its URLs only appear after the
    // signed-in user decrypts `content`. The decryptPrivate feed path
    // must run this with the decrypted tags + 'private' visibility, or
    // an Amethyst/Primal "private bookmarks" list renders empty.
    const out = extractImportedUrls(
      ev({ kind: 10003, tags: [] }),
      [['r', 'https://private.example/secret']],
      'private',
    );

    expect(out).toHaveLength(1);
    expect(out[0]?.url).toBe('https://private.example/secret');
    expect(out[0]?.visibility).toBe('private');
  });
});

describe('extractImportedNoteRefs', () => {
  it('keeps separate stable savedAt and listCreatedAt fields', () => {
    const out = extractImportedNoteRefs(
      ev({
        kind: 10003,
        created_at: 1_800_000_000,
        tags: [['e', 'a'.repeat(64)]],
      }),
    );

    expect(out[0]?.savedAt).toBe(1_800_000_000);
    expect(out[0]?.listCreatedAt).toBe(1_800_000_000);
    expect(out[0]?.visibility).toBe('public');
  });

  it('extracts relay hints from e-tags', () => {
    const out = extractImportedNoteRefs(
      ev({
        kind: 10003,
        tags: [['e', 'a'.repeat(64), 'wss://relay.example/']],
      }),
    );

    expect(out[0]?.relayHints).toEqual(['wss://relay.example']);
  });

  it('extracts note refs from Nostr URLs in r-tags', () => {
    const out = extractImportedNoteRefs(
      ev({
        kind: 10003,
        tags: [['r', `https://primal.net/e/${'b'.repeat(64)}`]],
      }),
    );

    expect(out[0]?.targetEventId).toBe('b'.repeat(64));
  });

  it('does not import note refs from Deepmarks collection events', () => {
    const out = extractImportedNoteRefs(
      ev({
        kind: 30003,
        tags: [
          ['d', 'deepmarks-collection:nostr-posts'],
          ['r', `https://primal.net/e/${'b'.repeat(64)}`],
        ],
      }),
    );
    expect(out).toEqual([]);
  });

  it('can extract refs from decrypted private NIP-51 tag arrays', () => {
    const out = extractImportedNoteRefs(
      ev({ kind: 10003, tags: [] }),
      [['e', 'c'.repeat(64)]],
      'private',
    );

    expect(out[0]?.targetEventId).toBe('c'.repeat(64));
    expect(out[0]?.visibility).toBe('private');
  });
});

describe('private NIP-51 tag decryption', () => {
  it('validates private tag array shape', () => {
    expect(isValidNip51PrivateTags([['e', 'a'.repeat(64)]])).toBe(true);
    expect(isValidNip51PrivateTags([[42]])).toBe(false);
    expect(isValidNip51PrivateTags([[['e', 'a'.repeat(64)]]])).toBe(false);
  });

  it('returns no-signer when private content exists but no signer is attached', async () => {
    mockedGetNdk.mockReturnValue(makeNdkMock(null));
    const result = await tryDecryptNip51PrivateTags(
      ev({ kind: 10003, content: 'cipher', tags: [] }),
      'curator',
    );
    expect(result).toEqual({ ok: false, reason: 'no-signer' });
  });

  it('prefers NIP-04 for legacy iv ciphertext and falls back to NIP-44', async () => {
    const decrypt = vi.fn()
      .mockRejectedValueOnce(new Error('legacy failed'))
      .mockResolvedValueOnce(JSON.stringify([['e', 'd'.repeat(64)]]));
    mockedGetNdk.mockReturnValue(makeNdkMock(decrypt));

    const result = await tryDecryptNip51PrivateTags(
      ev({ kind: 10003, content: 'cipher?iv=legacy', tags: [] }),
      'curator',
    );

    expect(result.ok).toBe(true);
    expect(decrypt).toHaveBeenNthCalledWith(1, { pubkey: 'curator' }, 'cipher?iv=legacy', 'nip04');
    expect(decrypt).toHaveBeenNthCalledWith(2, { pubkey: 'curator' }, 'cipher?iv=legacy', 'nip44');
  });
});

describe('mergeImportedReplacement', () => {
  it('updates list metadata from a newer replacement without moving savedAt', () => {
    const existing = {
      savedAt: 1_700_000_000,
      eventCreatedAt: 1_700_000_000,
      eventId: 'old',
      title: 'Old title',
    };
    const incoming = {
      savedAt: 1_800_000_000,
      eventCreatedAt: 1_800_000_000,
      eventId: 'new',
      title: 'New title',
    };

    expect(mergeImportedReplacement(existing, incoming)).toEqual({
      savedAt: 1_700_000_000,
      eventCreatedAt: 1_800_000_000,
      eventId: 'new',
      title: 'New title',
      savedAtMs: undefined,
    });
  });

  it('ignores older replacement events after a newer list has been seen', () => {
    const existing = {
      savedAt: 1_700_000_000,
      eventCreatedAt: 1_800_000_000,
      eventId: 'new',
    };
    const incoming = {
      savedAt: 1_600_000_000,
      eventCreatedAt: 1_600_000_000,
      eventId: 'old',
    };

    expect(mergeImportedReplacement(existing, incoming)).toBeNull();
  });
});
