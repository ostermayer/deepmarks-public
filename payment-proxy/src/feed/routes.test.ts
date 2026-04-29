import { describe, it, expect } from 'vitest';
import { applyAttributionPreference } from './routes.js';
import type { BookmarkJson } from '../api-helpers.js';

function bm(pubkey: string, url: string): BookmarkJson {
  return {
    id: `${pubkey}-${url}`,
    pubkey,
    url,
    title: url,
    description: '',
    tags: [],
    archivedForever: false,
    savedAt: 0,
  };
}

const DEEPMARKS = 'deepmarks-pubkey';
const ALICE = 'alice';
const BOB = 'bob';

describe('applyAttributionPreference (backend mirror of frontend rule)', () => {
  it('keeps deepmarks entries when no other curator has the same URL', () => {
    const out = applyAttributionPreference(
      [bm(DEEPMARKS, 'https://solo.test')],
      new Set([DEEPMARKS]),
    );
    expect(out).toHaveLength(1);
  });

  it('drops deepmarks entries when another curator shares the URL', () => {
    const out = applyAttributionPreference(
      [bm(DEEPMARKS, 'https://x.test'), bm(ALICE, 'https://x.test')],
      new Set([DEEPMARKS]),
    );
    expect(out.map((b) => b.pubkey)).toEqual([ALICE]);
  });

  it('leaves multiple real curators of the same URL intact', () => {
    const out = applyAttributionPreference(
      [bm(ALICE, 'https://x'), bm(BOB, 'https://x'), bm(DEEPMARKS, 'https://x')],
      new Set([DEEPMARKS]),
    );
    expect(out.map((b) => b.pubkey).sort()).toEqual([ALICE, BOB].sort());
  });

  it('is a no-op when the hide set is empty', () => {
    const inputs = [bm(DEEPMARKS, 'https://x'), bm(ALICE, 'https://x')];
    expect(applyAttributionPreference(inputs, new Set())).toEqual(inputs);
  });

  it('does not mutate input', () => {
    const inputs = [bm(DEEPMARKS, 'https://x'), bm(ALICE, 'https://x')];
    const snapshot = JSON.stringify(inputs);
    applyAttributionPreference(inputs, new Set([DEEPMARKS]));
    expect(JSON.stringify(inputs)).toBe(snapshot);
  });
});
