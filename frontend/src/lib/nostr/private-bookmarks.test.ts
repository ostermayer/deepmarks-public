import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock NDK so the encrypt/decrypt path stays under our control.
vi.mock('./ndk.js', () => ({
  getNdk: vi.fn()
}));

import {
  isValidEntriesShape,
  tryDecryptPrivateSet,
  decryptPrivateSet,
  buildPrivateSetEvent,
  bookmarkInputToInnerTags,
  type DecryptResult
} from './private-bookmarks.js';
import { getNdk } from './ndk.js';
import { KIND } from './kinds.js';
import type { SignedEventLike } from './bookmarks.js';

const mockedGetNdk = getNdk as unknown as ReturnType<typeof vi.fn>;

function makeSignerMock(opts: {
  decryptResult?: string | (() => Promise<string>) | (() => never);
  encryptResult?: string;
} = {}) {
  return {
    decrypt: vi.fn(async () => {
      if (typeof opts.decryptResult === 'function') return opts.decryptResult();
      return opts.decryptResult ?? '[]';
    }),
    encrypt: vi.fn(async () => opts.encryptResult ?? 'CIPHERTEXT')
  };
}

function makeNdkMock(signer: ReturnType<typeof makeSignerMock> | null) {
  return {
    signer,
    getUser: ({ pubkey }: { pubkey: string }) => ({ pubkey })
  };
}

beforeEach(() => {
  mockedGetNdk.mockReset();
});

describe('isValidEntriesShape', () => {
  it('accepts an array of arrays of strings', () => {
    expect(isValidEntriesShape([])).toBe(true);
    expect(isValidEntriesShape([[['d', 'https://x']]])).toBe(true);
    expect(isValidEntriesShape([[['d', 'https://x'], ['t', 'tag']]])).toBe(true);
  });
  it('rejects non-arrays at any level', () => {
    expect(isValidEntriesShape({})).toBe(false);
    expect(isValidEntriesShape('string')).toBe(false);
    expect(isValidEntriesShape([{}])).toBe(false);
    expect(isValidEntriesShape([['d', 'url']])).toBe(false); // missing inner array
    expect(isValidEntriesShape([[['d', 1]]])).toBe(false);   // non-string cell
    expect(isValidEntriesShape([[null]])).toBe(false);
  });
});

describe('tryDecryptPrivateSet', () => {
  it('returns no-event when input is null', async () => {
    const r: DecryptResult = await tryDecryptPrivateSet(null, 'me');
    expect(r).toEqual({ ok: false, reason: 'no-event' });
  });

  it('returns no-signer when no signer is attached', async () => {
    mockedGetNdk.mockReturnValue(makeNdkMock(null));
    const r = await tryDecryptPrivateSet(makeEvent('me', 'ct'), 'me');
    expect(r).toEqual({ ok: false, reason: 'no-signer' });
  });

  it('returns wrong-key when event author is not the expected owner', async () => {
    mockedGetNdk.mockReturnValue(makeNdkMock(makeSignerMock()));
    const r = await tryDecryptPrivateSet(makeEvent('someone-else', 'ct'), 'me');
    expect(r).toEqual({ ok: false, reason: 'wrong-key' });
  });

  it('returns wrong-key when signer.decrypt throws', async () => {
    mockedGetNdk.mockReturnValue(
      makeNdkMock(makeSignerMock({ decryptResult: () => { throw new Error('mac fail'); } }))
    );
    const r = await tryDecryptPrivateSet(makeEvent('me', 'ct'), 'me');
    expect(r).toEqual({ ok: false, reason: 'wrong-key' });
  });

  it('returns corrupt-json when plaintext is not JSON', async () => {
    mockedGetNdk.mockReturnValue(
      makeNdkMock(makeSignerMock({ decryptResult: 'not json' }))
    );
    const r = await tryDecryptPrivateSet(makeEvent('me', 'ct'), 'me');
    expect(r).toEqual({ ok: false, reason: 'corrupt-json' });
  });

  it('returns wrong-shape when JSON parses but is not entries shape', async () => {
    mockedGetNdk.mockReturnValue(
      makeNdkMock(makeSignerMock({ decryptResult: '{"foo":1}' }))
    );
    const r = await tryDecryptPrivateSet(makeEvent('me', 'ct'), 'me');
    expect(r).toEqual({ ok: false, reason: 'wrong-shape' });
  });

  it('returns ok with the parsed entries on success', async () => {
    const inner = JSON.stringify([
      [['d', 'https://x.test'], ['title', 'X'], ['t', 'bitcoin']]
    ]);
    mockedGetNdk.mockReturnValue(
      makeNdkMock(makeSignerMock({ decryptResult: inner }))
    );
    const r = await tryDecryptPrivateSet(makeEvent('me', 'ct'), 'me');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.set.entries).toHaveLength(1);
      expect(r.set.entries[0]).toEqual([
        ['d', 'https://x.test'],
        ['title', 'X'],
        ['t', 'bitcoin']
      ]);
      expect(r.set.baseEventId).toBe('event-1');
    }
  });
});

describe('decryptPrivateSet (UI wrapper)', () => {
  it('returns empty entries on null event', async () => {
    expect(await decryptPrivateSet(null)).toEqual({ entries: [] });
  });

  it('returns empty entries on any failure mode without throwing', async () => {
    mockedGetNdk.mockReturnValue(makeNdkMock(null));
    const result = await decryptPrivateSet(makeEvent('me', 'ct'));
    expect(result.entries).toEqual([]);
    expect(result.baseEventId).toBe('event-1');
  });
});

describe('buildPrivateSetEvent', () => {
  it('throws when no signer is attached', async () => {
    mockedGetNdk.mockReturnValue(makeNdkMock(null));
    await expect(
      buildPrivateSetEvent({ entries: [] }, 'me')
    ).rejects.toThrow(/Sign in/);
  });

  it('builds a kind:30003 event with d=deepmarks-private and ciphertext content', async () => {
    const signer = makeSignerMock({ encryptResult: 'CIPHER!' });
    mockedGetNdk.mockReturnValue(makeNdkMock(signer));
    const template = await buildPrivateSetEvent(
      { entries: [[['d', 'https://x']]] },
      'me'
    );
    expect(template.kind).toBe(KIND.privateBookmarkSet);
    expect(template.tags).toEqual([['d', 'deepmarks-private']]);
    expect(template.content).toBe('CIPHER!');
    // The encrypt call MUST go to the user's own pubkey (encrypt-to-self).
    expect(signer.encrypt).toHaveBeenCalledWith({ pubkey: 'me' }, expect.any(String), 'nip44');
  });
});

describe('bookmarkInputToInnerTags', () => {
  it('reuses the kind:39701 tag schema verbatim', () => {
    const tags = bookmarkInputToInnerTags({
      url: 'https://example.com/x',
      title: 'X',
      description: 'desc',
      tags: ['a', 'b']
    });
    expect(tags.find((t) => t[0] === 'd')?.[1]).toBe('https://example.com/x');
    expect(tags.find((t) => t[0] === 'title')?.[1]).toBe('X');
    expect(tags.filter((t) => t[0] === 't').map((t) => t[1])).toEqual(['a', 'b']);
  });
});

function makeEvent(pubkey: string, content: string): SignedEventLike {
  return {
    id: 'event-1',
    pubkey,
    kind: KIND.privateBookmarkSet,
    created_at: 1700000000,
    tags: [['d', 'deepmarks-private']],
    content
  };
}
