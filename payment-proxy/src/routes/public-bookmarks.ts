import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import {
  SignedEventSchema,
  bookmarkEventToJson,
  publishToRelays,
  queryRelaysWithTimeout,
} from '../api-helpers.js';
import { cachePublicBookmarkEvent, listCachedPublicBookmarks } from '../public-bookmark-cache.js';
import type { Deps } from '../route-deps.js';
import { validateSafePublicHttpUrl } from '../safe-url.js';

const AuthorQuerySchema = z.object({
  author: z.string().regex(/^[0-9a-f]{64}$/),
  limit: z.string().optional(),
});

export function register(deps: Deps): void {
  const {
    app,
    blocklist,
    meili,
    rateLimit,
    redis,
    relayPool,
    INDEXER_RELAY_URL_FOR_API,
  } = deps;

  app.get('/bookmarks/public', async (request, reply) => {
    const parsed = AuthorQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid query', details: parsed.error.flatten() });
    }
    const gate = await rateLimit('public-bookmarks-read-ip', request.ip, 120, 60);
    if (!gate.ok) {
      reply.header('Retry-After', String(gate.retryAfter));
      return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
    }

    const limit = parseLimit(parsed.data.limit);
    if (await blocklist.isPubkeySuspended(parsed.data.author)) {
      return reply.status(403).send({ error: 'pubkey suspended' });
    }
    let bookmarks = await listCachedPublicBookmarks(redis, parsed.data.author, limit);

    // The indexer only subscribes to events from the last 24h. Users
    // who imported a bookmark backlog (Pinboard, Raindrop, etc.) have
    // thousands of older kind:39701 events on strfry that never went
    // through the indexer, so the per-author cache permanently lags.
    //
    // Fix: when the cache is short of `limit`, do a one-shot relay
    // backfill that pulls the full history and primes the cache.
    // Marked with a 24h-TTL Redis key so we don't reissue the relay
    // query for every page-view.
    const backfillKey = `dm:bookmarks:backfilled:${parsed.data.author}`;
    const alreadyBackfilled = (await redis.get(backfillKey).catch(() => null)) === '1';
    const inlineBackfillTimeoutMs = bookmarks.length === 0 ? 4_000 : 2_000;
    const backfillLimit = Math.max(limit, 5_000);
    if (!alreadyBackfilled && bookmarks.length < limit) {
      const events = await queryRelaysWithTimeout(
        relayPool,
        [INDEXER_RELAY_URL_FOR_API],
        { kinds: [39701], authors: [parsed.data.author], limit: backfillLimit },
        inlineBackfillTimeoutMs,
      );
      if (events.length > 0) {
        await Promise.allSettled(events.map((event) => cachePublicBookmarkEvent(redis, event)));
        void redis.set(backfillKey, '1', 'EX', 24 * 60 * 60).catch(() => undefined);
        const fromRelay = events
          .map(bookmarkEventToJson)
          .filter((b) => b.url);
        const byId = new Map<string, ReturnType<typeof bookmarkEventToJson>>();
        for (const b of bookmarks) byId.set(b.id, b);
        for (const b of fromRelay) byId.set(b.id, b);
        bookmarks = [...byId.values()]
          .sort((a, b) => b.savedAt - a.savedAt || b.id.localeCompare(a.id))
          .slice(0, limit);
      }
    }

    bookmarks = (await Promise.all(bookmarks.map(async (bookmark) => {
      if (await blocklist.isEventDelisted(bookmark.id)) return null;
      if (await blocklist.isUrlBlocked(bookmark.url)) return null;
      return bookmark;
    }))).filter((bookmark): bookmark is NonNullable<typeof bookmark> => bookmark !== null);

    return { bookmarks, count: bookmarks.length };
  });

  app.post('/bookmarks/public', async (request, reply) => {
    const parsed = SignedEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid event', details: parsed.error.flatten() });
    }
    const event = parsed.data as NostrEvent;
    if (event.kind !== 39701) {
      return reply.status(400).send({ error: 'expected kind:39701 (public web bookmark)' });
    }
    if (!verifyEvent(event)) {
      return reply.status(400).send({ error: 'event signature does not verify' });
    }
    if (!isReasonableCreatedAt(event.created_at)) {
      return reply.status(400).send({ error: 'created_at must not be more than 10 minutes in the future' });
    }

    const dTag = event.tags.find((t) => t[0] === 'd' && typeof t[1] === 'string' && t[1]);
    if (!dTag?.[1]) return reply.status(400).send({ error: 'kind:39701 requires a d-tag with the URL' });
    try { validateSafePublicHttpUrl(dTag[1]); }
    catch { return reply.status(400).send({ error: 'd-tag must be a public http(s) URL' }); }

    const ipGate = await rateLimit('public-bookmarks-ingest-ip', request.ip, 180, 60);
    if (!ipGate.ok) {
      reply.header('Retry-After', String(ipGate.retryAfter));
      return reply.status(429).send({ error: 'rate limit', retryAfter: ipGate.retryAfter });
    }
    const pkGate = await rateLimit('public-bookmarks-ingest-pk', event.pubkey, 120, 60);
    if (!pkGate.ok) {
      reply.header('Retry-After', String(pkGate.retryAfter));
      return reply.status(429).send({ error: 'rate limit', retryAfter: pkGate.retryAfter });
    }

    if (await blocklist.isPubkeySuspended(event.pubkey)) {
      return reply.status(403).send({ error: 'pubkey suspended' });
    }
    if (await blocklist.isEventDelisted(event.id)) {
      return reply.status(403).send({ error: 'event delisted' });
    }
    if (await blocklist.isUrlBlocked(dTag[1])) {
      return reply.status(403).send({ error: 'url blocked' });
    }

    await cachePublicBookmarkEvent(redis, event);
    const doc = await meiliBookmarkDoc(event, deps).catch(() => null);
    if (doc) void meili.upsertBatch([doc]).catch((err) => app.log.warn({ err, eventId: event.id }, 'bookmark ingest meili upsert failed'));

    const { ok, failed } = await publishToRelays(relayPool, [INDEXER_RELAY_URL_FOR_API], event, 3_000);
    return { eventId: event.id, cached: true, publishedTo: ok, failedRelays: failed };
  });
}

async function meiliBookmarkDoc(event: NostrEvent, deps: Deps): Promise<import('../search.js').BookmarkDoc | null> {
  const url = event.tags.find((t) => t[0] === 'd')?.[1];
  if (!url) return null;

  let domain = 'unknown';
  try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep unknown */ }

  const hash = await sha256hex(url);
  const title = event.tags.find((t) => t[0] === 'title')?.[1] ?? '';
  const description = event.tags.find((t) => t[0] === 'description')?.[1] ?? '';
  const tags = event.tags.filter((t) => t[0] === 't').map((t) => t[1]).filter((v): v is string => !!v);
  const author_name = (await deps.redis.get(`dm:profile-name:${event.pubkey}`)) ?? undefined;
  const save_count = await deps.redis.scard(`dm:url-savers:${hash}`).catch(() => 0);

  return {
    id: event.id,
    url,
    title,
    description,
    tags,
    author_pubkey: event.pubkey,
    author_name,
    domain,
    created_at: event.created_at,
    zap_total: 0,
    save_count,
  };
}

async function sha256hex(s: string): Promise<string> {
  return bytesToHex(sha256(new TextEncoder().encode(s)));
}

function isReasonableCreatedAt(createdAt: number): boolean {
  if (!Number.isInteger(createdAt) || createdAt <= 0) return false;
  const now = Math.floor(Date.now() / 1000);
  return createdAt <= now + 10 * 60;
}

function parseLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '200', 10);
  if (!Number.isFinite(parsed)) return 200;
  return Math.min(Math.max(parsed, 1), 500);
}
