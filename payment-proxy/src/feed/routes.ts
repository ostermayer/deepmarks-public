// Atom feed routes: /feed/{network,recent,popular,tags/:tag,user/:npub}.xml
//
// Each route subscribes to the indexer relay for kind:39701 events, applies
// the attribution-preference rule (hide deepmarks-seeded events when a
// real user has the same URL — matches the frontend), sorts per the feed
// kind, and emits Atom. Responses are cached in-memory for 60 s so feed
// readers that re-poll aggressively don't thrash Nostr relays.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { SimplePool, nip19, type Event as NostrEvent } from 'nostr-tools';
import { bookmarkEventToJson, type BookmarkJson } from '../api-helpers.js';
import { buildAtomFeed, type FeedMeta } from './atom.js';
import { rankByPopularity } from './rank.js';

const CACHE_TTL_MS = 60_000;
const DEFAULT_LIMIT = 100;
const FEED_QUERY_TIMEOUT_MS = 2500;

interface CacheEntry {
  body: string;
  cachedAt: number;
}

interface FeedDeps {
  pool: SimplePool;
  indexerRelay: string;
  publicBaseUrl: string;
  deepmarksPubkey: string;
  /** Optional. When provided, /feed/user/:slug.xml accepts deepmarks
   *  short usernames (e.g. /feed/user/dan.xml) in addition to npubs.
   *  Falls back to the npub-only path when omitted. */
  resolveUsername?: (name: string) => Promise<string | null>;
}

function hidePubkeysSet(deps: FeedDeps): Set<string> {
  return new Set([deps.deepmarksPubkey]);
}

/** Apply the attribution-preference rule: drop deepmarks events whose URL also exists from another curator. */
export function applyAttributionPreference(
  bookmarks: BookmarkJson[],
  hidePubkeys: Set<string>,
): BookmarkJson[] {
  if (hidePubkeys.size === 0) return bookmarks;
  const urlsFromOthers = new Set<string>();
  for (const b of bookmarks) {
    if (!hidePubkeys.has(b.pubkey)) urlsFromOthers.add(b.url);
  }
  return bookmarks.filter(
    (b) => !hidePubkeys.has(b.pubkey) || !urlsFromOthers.has(b.url),
  );
}

async function fetchEvents(
  pool: SimplePool,
  relay: string,
  filter: Record<string, unknown>,
  timeoutMs = FEED_QUERY_TIMEOUT_MS,
): Promise<NostrEvent[]> {
  const out: NostrEvent[] = [];
  await new Promise<void>((resolve) => {
    const sub = pool.subscribeMany([relay], filter as never, {
      onevent: (e) => out.push(e),
      oneose: () => { sub.close(); resolve(); },
    });
    setTimeout(() => { sub.close(); resolve(); }, timeoutMs);
  });
  return out;
}

function eventsToBookmarks(events: NostrEvent[]): BookmarkJson[] {
  return events.map((e) => bookmarkEventToJson(e)).filter((b) => b.url !== '');
}

/** Memoised per route-key to cap load on the indexer relay. */
function makeCache() {
  const map = new Map<string, CacheEntry>();
  return {
    get(key: string): string | null {
      const entry = map.get(key);
      if (!entry) return null;
      if (Date.now() - entry.cachedAt > CACHE_TTL_MS) return null;
      return entry.body;
    },
    set(key: string, body: string): void {
      map.set(key, { body, cachedAt: Date.now() });
    },
  };
}

/** Register all Atom feed routes on the given Fastify instance. */
export function registerFeedRoutes(app: FastifyInstance, deps: FeedDeps): void {
  const cache = makeCache();

  function sendXml(reply: FastifyReply, body: string): string {
    reply.header('content-type', 'application/atom+xml; charset=utf-8');
    reply.header('cache-control', `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
    return body;
  }

  // ── /feed/network.xml + /feed/recent.xml — both sort by recency ──────
  async function renderRecent(): Promise<string> {
    const events = await fetchEvents(deps.pool, deps.indexerRelay, {
      kinds: [39701],
      limit: DEFAULT_LIMIT,
    });
    const all = eventsToBookmarks(events);
    const filtered = applyAttributionPreference(all, hidePubkeysSet(deps));
    filtered.sort((a, b) => b.savedAt - a.savedAt);
    return buildAtomFeed(
      {
        title: 'Deepmarks · Recent',
        subtitle: 'The newest public bookmarks across the network.',
        htmlUrl: `${deps.publicBaseUrl}/app/recent`,
        feedUrl: `${deps.publicBaseUrl}/feed/recent.xml`,
        id: `${deps.publicBaseUrl}/feed/recent`,
      },
      filtered.slice(0, DEFAULT_LIMIT),
    );
  }

  app.get('/feed/recent.xml', async (_req, reply) => {
    const hit = cache.get('recent');
    if (hit) return sendXml(reply, hit);
    const body = await renderRecent();
    cache.set('recent', body);
    return sendXml(reply, body);
  });
  app.get('/feed/network.xml', async (_req, reply) => {
    const hit = cache.get('recent');
    if (hit) return sendXml(reply, hit);
    const body = await renderRecent();
    cache.set('recent', body);
    return sendXml(reply, body);
  });

  // ── /feed/popular.xml ────────────────────────────────────────────────
  app.get('/feed/popular.xml', async (_req, reply) => {
    const key = 'popular';
    const hit = cache.get(key);
    if (hit) return sendXml(reply, hit);
    const events = await fetchEvents(deps.pool, deps.indexerRelay, {
      kinds: [39701],
      limit: 500, // wider net for popularity ranking
    });
    const filtered = applyAttributionPreference(eventsToBookmarks(events), hidePubkeysSet(deps));
    const ranked = rankByPopularity(filtered).slice(0, DEFAULT_LIMIT);
    const body = buildAtomFeed(
      {
        title: 'Deepmarks · Popular',
        subtitle: 'Bookmarks saved by the most distinct curators.',
        htmlUrl: `${deps.publicBaseUrl}/app/popular`,
        feedUrl: `${deps.publicBaseUrl}/feed/popular.xml`,
        id: `${deps.publicBaseUrl}/feed/popular`,
      },
      ranked,
    );
    cache.set(key, body);
    return sendXml(reply, body);
  });

  // ── /feed/tags/:tag.xml ──────────────────────────────────────────────
  app.get<{ Params: { tag: string } }>(
    '/feed/tags/:tag.xml',
    async (req, reply) => {
      const tag = req.params.tag.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(tag)) {
        return reply.status(400).send({ error: 'invalid tag' });
      }
      const key = `tag:${tag}`;
      const hit = cache.get(key);
      if (hit) return sendXml(reply, hit);
      const events = await fetchEvents(deps.pool, deps.indexerRelay, {
        kinds: [39701],
        '#t': [tag],
        limit: DEFAULT_LIMIT,
      });
      const filtered = applyAttributionPreference(
        eventsToBookmarks(events),
        hidePubkeysSet(deps),
      );
      filtered.sort((a, b) => b.savedAt - a.savedAt);
      const body = buildAtomFeed(
        {
          title: `Deepmarks · #${tag}`,
          subtitle: `Public bookmarks tagged #${tag}.`,
          htmlUrl: `${deps.publicBaseUrl}/app/tags/${encodeURIComponent(tag)}`,
          feedUrl: `${deps.publicBaseUrl}/feed/tags/${encodeURIComponent(tag)}.xml`,
          id: `${deps.publicBaseUrl}/feed/tags/${tag}`,
        },
        filtered.slice(0, DEFAULT_LIMIT),
      );
      cache.set(key, body);
      return sendXml(reply, body);
    },
  );

  // ── /feed/user/:slug.xml — a specific curator's public bookmarks ─────
  // Accepts either an npub1…, a hex pubkey, or a Deepmarks short
  // username (when resolveUsername is wired). Pinboard-style short
  // usernames are the friendlier subscribe URL — `dan.xml` beats a
  // 63-char npub for a feed reader's bookmark bar.
  app.get<{ Params: { slug: string } }>(
    '/feed/user/:slug.xml',
    async (req, reply) => {
      const slug = req.params.slug;
      let hex: string | null = null;
      if (/^[0-9a-f]{64}$/i.test(slug)) {
        hex = slug.toLowerCase();
      } else if (slug.startsWith('npub1')) {
        try {
          const decoded = nip19.decode(slug);
          if (decoded.type === 'npub') hex = decoded.data as string;
        } catch {
          /* fall through to username lookup */
        }
      } else if (deps.resolveUsername) {
        hex = await deps.resolveUsername(slug.toLowerCase()).catch(() => null);
      }
      if (!hex) {
        return reply.status(404).send({ error: 'unknown user' });
      }
      const npub = (() => {
        try { return nip19.npubEncode(hex!); } catch { return hex!; }
      })();
      const key = `user:${hex}`;
      const hit = cache.get(key);
      if (hit) return sendXml(reply, hit);
      const events = await fetchEvents(deps.pool, deps.indexerRelay, {
        kinds: [39701],
        authors: [hex],
        limit: DEFAULT_LIMIT,
      });
      const bookmarks = eventsToBookmarks(events);
      bookmarks.sort((a, b) => b.savedAt - a.savedAt);
      const body = buildAtomFeed(
        {
          title: `Deepmarks · ${slug.length <= 30 ? slug : npub.slice(0, 12) + '…'}`,
          subtitle: `Public bookmarks from ${slug}.`,
          htmlUrl: `${deps.publicBaseUrl}/u/${npub}`,
          feedUrl: `${deps.publicBaseUrl}/feed/user/${encodeURIComponent(slug)}.xml`,
          id: `${deps.publicBaseUrl}/feed/user/${hex}`,
        },
        bookmarks.slice(0, DEFAULT_LIMIT),
      );
      cache.set(key, body);
      return sendXml(reply, body);
    },
  );
}

/** Factory used by index.ts at boot — reads all env-derived config once. */
export function feedDepsFromEnv(pool: SimplePool): FeedDeps {
  const indexerRelay =
    process.env.INDEXER_RELAY_URL ?? 'wss://relay.deepmarks.org';
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'https://deepmarks.org';
  // Brand pubkey drives an attribution rule in feed filtering. We read
  // it directly from env instead of deriving from an nsec (the nsec
  // lives in the Box C bunker, not on this box). Feeds still work when
  // unset; the attribution rule just becomes a no-op.
  const deepmarksPubkey = process.env.BUNKER_BRAND_PUBKEY ?? '';
  return { pool, indexerRelay, publicBaseUrl, deepmarksPubkey };
}
