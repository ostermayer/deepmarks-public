import { afterEach, describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { applyAttributionPreference, feedDepsFromEnv, registerFeedRoutes } from '@src/feed/routes.js';
import type { BookmarkJson } from '@src/api-helpers.js';
import type { Event as NostrEvent } from 'nostr-tools';

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

function event(
  idSeed: string,
  overrides: {
    url?: string;
    title?: string;
    tags?: string[];
    pubkey?: string;
    createdAt?: number;
    kind?: number;
    content?: string;
    rawTags?: string[][];
  } = {},
): NostrEvent {
  const url = overrides.url ?? `https://example.com/${idSeed}`;
  return {
    id: idSeed.padEnd(64, idSeed[0] ?? 'a').slice(0, 64),
    pubkey: overrides.pubkey ?? '1'.repeat(64),
    created_at: overrides.createdAt ?? 1_700_000_000,
    kind: overrides.kind ?? 39701,
    tags: overrides.rawTags ?? [
      ['d', url],
      ['title', overrides.title ?? url],
      ...(overrides.tags ?? []).map((tag) => ['t', tag]),
    ],
    content: overrides.content ?? '',
    sig: '0'.repeat(128),
  };
}

function fakePool(events: NostrEvent[]) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    subscribeMany(_relays: string[], filter: Record<string, unknown>, handlers: {
      onevent?: (event: NostrEvent) => void;
      oneose?: () => void;
    }) {
      calls.push(filter);
      for (const ev of events) {
        const kinds = filter.kinds;
        if (Array.isArray(kinds) && !new Set(kinds as number[]).has(ev.kind)) continue;
        const authors = filter.authors;
        if (Array.isArray(authors) && !new Set(authors as string[]).has(ev.pubkey)) continue;
        const tags = filter['#t'];
        if (Array.isArray(tags)) {
          const wanted = new Set(tags as string[]);
          if (!ev.tags.some((t) => t[0] === 't' && wanted.has(t[1] ?? ''))) continue;
        }
        const dTags = filter['#d'];
        if (Array.isArray(dTags)) {
          const wanted = new Set(dTags as string[]);
          if (!ev.tags.some((t) => t[0] === 'd' && wanted.has(t[1] ?? ''))) continue;
        }
        handlers.onevent?.(ev);
      }
      queueMicrotask(() => handlers.oneose?.());
      return { close() { /* test stub */ } };
    },
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

  it('keeps feed links on deepmarks.org even when PUBLIC_BASE_URL is the API host', () => {
    process.env.PUBLIC_BASE_URL = 'https://api.deepmarks.org';
    delete process.env.FEED_PUBLIC_BASE_URL;

    const deps = feedDepsFromEnv({} as Parameters<typeof feedDepsFromEnv>[0]);

    expect(deps.publicBaseUrl).toBe('https://deepmarks.org');
  });

  it('honors FEED_PUBLIC_BASE_URL for alternate deployments', () => {
    process.env.FEED_PUBLIC_BASE_URL = 'https://example.org';

    const deps = feedDepsFromEnv({} as Parameters<typeof feedDepsFromEnv>[0]);

    expect(deps.publicBaseUrl).toBe('https://example.org');
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

describe('feed routes', () => {
  async function makeApp(events: NostrEvent[]) {
    const app = Fastify();
    const pool = fakePool(events);
    registerFeedRoutes(app, {
      pool: pool as unknown as Parameters<typeof registerFeedRoutes>[1]['pool'],
      indexerRelay: 'wss://relay.deepmarks.test',
      publicBaseUrl: 'https://deepmarks.org',
      deepmarksPubkey: BRAND_SOCIAL_PUBKEY,
      deepmarksSeederPubkey: BRAND_SOCIAL_PUBKEY,
      deepmarksEditorialPubkeys: [],
    });
    await app.ready();
    return { app, pool };
  }

  it('serves recent and popular Atom feeds', async () => {
    const { app } = await makeApp([
      event('a', { url: 'https://a.test', title: 'A', tags: ['bitcoin'], createdAt: 10 }),
      event('b', { url: 'https://b.test', title: 'B', tags: ['nostr'], createdAt: 20 }),
    ]);

    const recent = await app.inject('/feed/recent.xml');
    expect(recent.statusCode).toBe(200);
    expect(recent.headers['content-type']).toContain('application/atom+xml');
    expect(recent.body).toContain('<title>Deepmarks · Recent</title>');
    expect(recent.body).toContain('<link href="https://deepmarks.org/app/recent"/>');
    expect(recent.body).toContain('href="https://deepmarks.org/feed/recent.xml"');

    const popular = await app.inject('/feed/popular.xml');
    expect(popular.statusCode).toBe(200);
    expect(popular.body).toContain('<title>Deepmarks · Popular</title>');
    expect(popular.body).toContain('<link href="https://deepmarks.org/app/popular"/>');
    expect(popular.body).toContain('href="https://deepmarks.org/feed/popular.xml"');

    await app.close();
  });

  it('serves dynamic tag Atom feeds for every app-valid tag token', async () => {
    const { app, pool } = await makeApp([
      event('c', { url: 'https://c.test', title: 'C', tags: ['ai.tools'] }),
      event('d', { url: 'https://d.test', title: 'D', tags: ['bitcoin'] }),
    ]);

    const tag = await app.inject('/feed/tags/ai.tools.xml');

    expect(tag.statusCode).toBe(200);
    expect(tag.body).toContain('<title>Deepmarks · #ai.tools</title>');
    expect(tag.body).toContain('<category term="ai.tools"/>');
    expect(tag.body).not.toContain('<category term="bitcoin"/>');
    expect(pool.calls.at(-1)?.['#t']).toEqual(['ai.tools']);

    await app.close();
  });

  it('rejects unsafe tag feed path segments', async () => {
    const { app } = await makeApp([]);

    const res = await app.inject('/feed/tags/bad_tag.xml');

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('serves a friends Atom feed from the public Deepmarks friends set', async () => {
    const owner = '9'.repeat(64);
    const friend = '8'.repeat(64);
    const other = '7'.repeat(64);
    const { app, pool } = await makeApp([
      event('f', {
        kind: 30000,
        pubkey: owner,
        createdAt: 30,
        rawTags: [
          ['d', 'deepmarks-friends'],
          ['p', friend],
        ],
      }),
      event('g', {
        kind: 30000,
        pubkey: owner,
        createdAt: 20,
        rawTags: [
          ['d', 'deepmarks-friends'],
          ['p', other],
        ],
      }),
      event('h', {
        pubkey: friend,
        url: 'https://explicit.example/a',
        title: 'Explicit friend bookmark',
        createdAt: 40,
      }),
      event('i', {
        kind: 1,
        pubkey: friend,
        content: 'worth reading https://social.example/post',
        createdAt: 50,
        rawTags: [],
      }),
      event('j', {
        pubkey: other,
        url: 'https://old.example/hidden',
        title: 'Old friend set entry',
        createdAt: 60,
      }),
    ]);

    const res = await app.inject(`/feed/friends/${owner}.xml`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>Deepmarks · Friends of ');
    expect(res.body).toContain('Explicit friend bookmark');
    expect(res.body).toContain('https://social.example/post');
    expect(res.body).not.toContain('https://old.example/hidden');
    expect(pool.calls[0]).toMatchObject({ kinds: [30000], authors: [owner], '#d': ['deepmarks-friends'] });

    await app.close();
  });
});
