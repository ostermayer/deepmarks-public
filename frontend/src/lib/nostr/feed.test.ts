import { describe, it, expect } from 'vitest';
import { applyAttributionPreference, shouldReplace } from './feed.js';
import type { ParsedBookmark } from './bookmarks.js';

function bm(savedAt: number, eventId: string): ParsedBookmark {
  return {
    url: 'https://example.com/x',
    title: 'X',
    description: '',
    tags: [],
    archivedForever: false,
    savedAt,
    curator: 'pub',
    eventId
  };
}

function bmAt(curator: string, url: string, savedAt = 0, eventId = `${curator}-${url}`): ParsedBookmark {
  return {
    url,
    title: url,
    description: '',
    tags: [],
    archivedForever: false,
    savedAt,
    curator,
    eventId
  };
}

describe('shouldReplace', () => {
  it('keeps the newer event when savedAt differs', () => {
    expect(
      shouldReplace({ key: 'k', bookmark: bm(100, 'a') }, bm(200, 'b'))
    ).toBe(true);
  });
  it('rejects an older event when savedAt differs', () => {
    expect(
      shouldReplace({ key: 'k', bookmark: bm(200, 'b') }, bm(100, 'a'))
    ).toBe(false);
  });
  it('breaks ties by lexicographically larger event id (NIP-01)', () => {
    expect(
      shouldReplace({ key: 'k', bookmark: bm(100, 'aaa') }, bm(100, 'bbb'))
    ).toBe(true);
    expect(
      shouldReplace({ key: 'k', bookmark: bm(100, 'bbb') }, bm(100, 'aaa'))
    ).toBe(false);
  });
  it('rejects an exact duplicate (same savedAt + same id)', () => {
    expect(
      shouldReplace({ key: 'k', bookmark: bm(100, 'abc') }, bm(100, 'abc'))
    ).toBe(false);
  });
});

describe('applyAttributionPreference', () => {
  const DEEPMARKS = 'deepmarks-pubkey';
  const ALICE = 'alice-pubkey';
  const BOB = 'bob-pubkey';
  const hide = new Set([DEEPMARKS]);

  it('keeps deepmarks events when no other curator has the same URL', () => {
    const out = applyAttributionPreference(
      [bmAt(DEEPMARKS, 'https://x.test'), bmAt(DEEPMARKS, 'https://y.test')],
      hide,
    );
    expect(out).toHaveLength(2);
  });

  it('drops the deepmarks event when a real curator has the same URL', () => {
    const out = applyAttributionPreference(
      [bmAt(DEEPMARKS, 'https://x.test'), bmAt(ALICE, 'https://x.test')],
      hide,
    );
    expect(out.map((b) => b.curator)).toEqual([ALICE]);
  });

  it('keeps unrelated deepmarks URLs even when a different deepmarks URL has competition', () => {
    const out = applyAttributionPreference(
      [
        bmAt(DEEPMARKS, 'https://only-deepmarks.test'),
        bmAt(DEEPMARKS, 'https://contested.test'),
        bmAt(ALICE, 'https://contested.test'),
      ],
      hide,
    );
    const urls = out.map((b) => `${b.curator}:${b.url}`);
    expect(urls).toContain(`${DEEPMARKS}:https://only-deepmarks.test`);
    expect(urls).toContain(`${ALICE}:https://contested.test`);
    expect(urls).not.toContain(`${DEEPMARKS}:https://contested.test`);
  });

  it('preserves multiple non-deepmarks curators of the same URL (still distinct events)', () => {
    const out = applyAttributionPreference(
      [
        bmAt(ALICE, 'https://x.test'),
        bmAt(BOB, 'https://x.test'),
        bmAt(DEEPMARKS, 'https://x.test'),
      ],
      hide,
    );
    expect(out.map((b) => b.curator).sort()).toEqual([ALICE, BOB].sort());
  });

  it('is a no-op when hidePubkeys is empty', () => {
    const input = [bmAt(DEEPMARKS, 'https://x.test'), bmAt(ALICE, 'https://x.test')];
    expect(applyAttributionPreference(input, new Set())).toEqual(input);
  });

  it('does not mutate its input', () => {
    const input = [bmAt(DEEPMARKS, 'https://x.test'), bmAt(ALICE, 'https://x.test')];
    const before = JSON.stringify(input);
    applyAttributionPreference(input, hide);
    expect(JSON.stringify(input)).toBe(before);
  });
});
