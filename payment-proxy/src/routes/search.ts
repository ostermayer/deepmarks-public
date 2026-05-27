// /search/public — Pinboard-style modifier parsing, applies the
// delisted-events filter, returns paginated hits with highlights.

import { z } from 'zod';
import { parseQuery } from '../search.js';
import type { Deps } from '../route-deps.js';

const SearchQuerySchema = z.object({
  q: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
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

export function register(deps: Deps): void {
  const { app, redis, meili, rateLimit } = deps;

  // GET /search/public?q=rust+%23async+%40fiatjaf&limit=50&offset=0
  // Parses Pinboard-style modifiers, applies delisted-events filter,
  // returns paginated hits with highlights.
  app.get('/search/public', async (request, reply) => {
    // Per-IP gate so an unauthenticated attacker can't pin Meilisearch
    // (each call is a Meili query + Redis smembers + author-pubkey
    // lookup). 120/min ≈ 2/sec per IP — generous for real users
    // including auto-suggest, painful for scrapers.
    const gate = await rateLimit('search-public', request.ip, 120, 60);
    if (!gate.ok) {
      reply.header('Retry-After', String(gate.retryAfter));
      return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
    }
    const parsed = SearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid query' });
    }
    const { q = '', limit = 50, offset = 0 } = parsed.data;

    const parsedQuery = parseQuery(q, normalizeTag);

    // Resolve @handle → pubkey if the user used @author syntax.
    // For now: if the author field doesn't look like a hex pubkey,
    // look it up via our profile-name reverse index. If not found,
    // match nothing.
    if (parsedQuery.author && !/^[0-9a-f]{64}$/.test(parsedQuery.author)) {
      const pubkey = await redis.get(`dm:profile-pubkey:${parsedQuery.author.toLowerCase()}`);
      if (pubkey) parsedQuery.author = pubkey;
      else return { hits: [], total: 0, query_time_ms: 0 };
    }

    // Pull the delisted-events set from the blocklist store. Small,
    // cached in-process elsewhere in production; fresh read here is fine.
    const delistedEventIds = new Set<string>(
      await redis.smembers('dm:blocked-events') ?? [],
    );

    const result = await meili.search({
      ...parsedQuery,
      limit,
      offset,
      delistedEventIds,
    });

    return result;
  });
}
