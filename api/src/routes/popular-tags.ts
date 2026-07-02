// /tags/popular?url=… — aggregated tags applied to public kind:39701
// bookmarks of a given URL.
//
// Powers the share-extension + SaveBox autocomplete strip: "what have
// other Deepmarks users tagged this page with?" Returns lowercase tag
// strings ranked by frequency, capped to TOP_N. Empty array for URLs
// nobody else has bookmarked.
//
// Cached in Redis for 10 minutes — popular pages get a lot of hits to
// the same URL during a viral moment and we don't want to re-query
// strfry every paste.

import { queryRelaysWithTimeout } from '../api-helpers.js';
import { parseAllowedUrl } from '../metadata.js';
import type { Deps } from '../route-deps.js';

const CACHE_PREFIX = 'dm:popular-tags:';
const CACHE_TTL_SECONDS = 10 * 60;
const RELAY_TIMEOUT_MS = 1_500;
const RELAY_EVENT_LIMIT = 200;
const TOP_N = 16;
/** Tags applied by fewer than this many distinct authors are dropped —
 *  one person's quirky private label shouldn't pollute the suggestion
 *  strip for everyone else. */
const MIN_DISTINCT_AUTHORS = 1;

export function register(deps: Deps): void {
  const { app, redis, relayPool, INDEXER_RELAY_URL_FOR_API, gateRateLimit } = deps;

  app.get('/tags/popular', async (request, reply) => {
    const raw = (request.query as { url?: unknown } | undefined)?.url;
    const parsed = parseAllowedUrl(raw);
    if (!parsed) {
      return reply.status(400).send({ error: 'missing or invalid url' });
    }
    if (!(await gateRateLimit(reply, 'popular-tags-ip', request.ip, 60, 60))) return reply;

    const url = parsed.toString();
    const cacheKey = CACHE_PREFIX + url;
    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        reply.header('cache-control', 'public, max-age=300');
        return JSON.parse(cached);
      } catch {
        // Fall through and recompute.
      }
    }

    const events = await queryRelaysWithTimeout(
      relayPool,
      [INDEXER_RELAY_URL_FOR_API],
      { kinds: [39701], '#d': [url], limit: RELAY_EVENT_LIMIT },
      RELAY_TIMEOUT_MS,
    );

    const counts = new Map<string, number>();
    const authorsByTag = new Map<string, Set<string>>();
    for (const event of events) {
      for (const t of event.tags) {
        if (t[0] !== 't' || typeof t[1] !== 'string') continue;
        const tag = t[1].toLowerCase().trim();
        if (!tag || tag.length > 48) continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
        let authors = authorsByTag.get(tag);
        if (!authors) {
          authors = new Set();
          authorsByTag.set(tag, authors);
        }
        authors.add(event.pubkey);
      }
    }

    const ranked = [...counts.entries()]
      .filter(([tag]) => (authorsByTag.get(tag)?.size ?? 0) >= MIN_DISTINCT_AUTHORS)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_N)
      .map(([tag]) => tag);

    const body = { url, tags: ranked };
    void redis.set(cacheKey, JSON.stringify(body), 'EX', CACHE_TTL_SECONDS).catch(() => undefined);
    reply.header('cache-control', 'public, max-age=300');
    return body;
  });
}
