// /search/public — Pinboard-style modifier parsing, applies the
// delisted-events filter, returns paginated hits with highlights.

import { z } from 'zod';
import type { Redis } from 'ioredis';
import { parseQuery, type SearchQuery, type SearchResult } from '../search.js';
import { searchSemanticBookmarks } from '../llm-enrichment.js';
import type { Deps } from '../route-deps.js';

const SearchQuerySchema = z.object({
  q: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
  rerank: z.enum(['0', '1', 'false', 'true']).optional(),
});

/**
 * Normalize a tag for querying. Matches the client-side write
 * normalization so /tags/Rust and /tags/rust-programming both
 * match bookmarks stored under those canonical forms.
 */
function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/\s+/g, '-')
    .slice(0, 64);
}

async function publicSearchQuery(redis: Redis, rawQuery: string): Promise<SearchQuery | null> {
  const parsedQuery = parseQuery(rawQuery, normalizeTag);

  // Resolve @handle → pubkey if the user used @author syntax.
  // For now: if the author field doesn't look like a hex pubkey,
  // look it up via our profile-name reverse index. If not found,
  // match nothing.
  if (parsedQuery.author && !/^[0-9a-f]{64}$/.test(parsedQuery.author)) {
    const pubkey = await redis.get(`dm:profile-pubkey:${parsedQuery.author.toLowerCase()}`);
    if (pubkey) parsedQuery.author = pubkey;
    else return null;
  }

  return {
    ...parsedQuery,
    delistedEventIds: await blockedEventIds(redis),
  };
}

async function blockedEventIds(redis: Redis): Promise<Set<string>> {
  return new Set<string>((await redis.smembers('dm:blocked-events')) ?? []);
}

function emptyResult(): SearchResult {
  return { hits: [], total: 0, query_time_ms: 0 };
}

export function register(deps: Deps): void {
  const { app, redis, meili, gateRateLimit, llm, semanticStore } = deps;

  // GET /search/public?q=rust+%23async+%40fiatjaf&limit=50&offset=0
  // Parses Pinboard-style modifiers, applies delisted-events filter,
  // returns paginated hits with highlights.
  app.get('/search/public', async (request, reply) => {
    // Per-IP gate so an unauthenticated attacker can't pin Meilisearch
    // (each call is a Meili query + Redis smembers + author-pubkey
    // lookup). 120/min ≈ 2/sec per IP — generous for real users
    // including auto-suggest, painful for scrapers.
    if (!(await gateRateLimit(reply, 'search-public', request.ip, 120, 60))) return reply;
    const parsed = SearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid query' });
    }
    const { q = '', limit = 50, offset = 0 } = parsed.data;

    const parsedQuery = await publicSearchQuery(redis, q);
    if (!parsedQuery) return emptyResult();

    const result = await meili.search({
      ...parsedQuery,
      limit,
      offset,
    });

    return result;
  });

  // GET /search/semantic/public?q=... — vector search over public bookmarks
  // enriched by the LLM indexer, with optional DeepInfra reranking.
  app.get('/search/semantic/public', async (request, reply) => {
    if (!(await gateRateLimit(reply, 'search-semantic-public', request.ip, 30, 60))) return reply;
    const parsed = SearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid query' });
    }
    if (!llm.enabled) {
      return reply.status(503).send({ error: 'semantic search unavailable' });
    }
    const { q = '', limit = 20, offset = 0 } = parsed.data;
    const rerank = parsed.data.rerank === undefined
      ? undefined
      : parsed.data.rerank === '1' || parsed.data.rerank === 'true';
    if (!q.trim()) return { hits: [], total: 0, query_time_ms: 0 };
    const parsedQuery = await publicSearchQuery(redis, q);
    if (!parsedQuery) return emptyResult();
    const semanticText = parsedQuery.q || parsedQuery.tags?.join(' ') || q;
    return searchSemanticBookmarks(redis, llm, semanticText, {
      ...parsedQuery,
      limit,
      offset,
      rerank,
      semanticStore,
    });
  });
}
