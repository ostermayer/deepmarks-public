import { afterEach, describe, it, expect } from 'vitest';
import { applyAttributionPreference, feedDepsFromEnv } from './routes.js';
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
const ADMIN_PUBKEY = '7cb39c6fb61007613e90ffce2220887219d41601235ff08d09eae396a7d73800';
const BRAND_SOCIAL_PUBKEY = '2944e915ba71cf0fc19f5dda048ce053a87c01fd7478b179330a17edca4ce2f4';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

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

describe('feedDepsFromEnv', () => {
  it('defaults feed attribution to the public brand/social key plus the legacy admin seeder key', () => {
    delete process.env.DEEPMARKS_PUBLIC_BRAND_PUBKEY;
    delete process.env.DEEPMARKS_SEEDER_PUBKEY;
    delete process.env.VITE_DEEPMARKS_PUBKEY;
    process.env.BUNKER_BRAND_PUBKEY = ADMIN_PUBKEY;

    const deps = feedDepsFromEnv({} as Parameters<typeof feedDepsFromEnv>[0]);

    expect(deps.deepmarksPubkey).toBe(BRAND_SOCIAL_PUBKEY);
    expect(deps.deepmarksSeederPubkey).toBe(BRAND_SOCIAL_PUBKEY);
    expect(deps.deepmarksEditorialPubkeys).toEqual([BRAND_SOCIAL_PUBKEY, ADMIN_PUBKEY]);
  });

  it('honors an explicit public brand/social pubkey override', () => {
    const override = 'f'.repeat(64);
    process.env.DEEPMARKS_PUBLIC_BRAND_PUBKEY = override;
    delete process.env.DEEPMARKS_SEEDER_PUBKEY;
    process.env.BUNKER_BRAND_PUBKEY = ADMIN_PUBKEY;

    const deps = feedDepsFromEnv({} as Parameters<typeof feedDepsFromEnv>[0]);

    expect(deps.deepmarksPubkey).toBe(override);
    expect(deps.deepmarksEditorialPubkeys).toEqual([override, ADMIN_PUBKEY]);
  });

  it('honors an explicit seeder pubkey override', () => {
    const override = 'e'.repeat(64);
    delete process.env.DEEPMARKS_PUBLIC_BRAND_PUBKEY;
    delete process.env.VITE_DEEPMARKS_PUBKEY;
    process.env.DEEPMARKS_SEEDER_PUBKEY = override;
    process.env.BUNKER_BRAND_PUBKEY = ADMIN_PUBKEY;

    const deps = feedDepsFromEnv({} as Parameters<typeof feedDepsFromEnv>[0]);

    expect(deps.deepmarksSeederPubkey).toBe(override);
    expect(deps.deepmarksEditorialPubkeys).toEqual([override, BRAND_SOCIAL_PUBKEY, ADMIN_PUBKEY]);
  });
});
