// /api/v1/* — programmatic access for LIFETIME-tier members only.
//
// Two auth schemes across /api/v1:
//   - Key management (POST/GET/DELETE /api/v1/keys) uses NIP-98 (signed
//     event in Authorization header) so the user proves nsec possession
//     before we hand them a rotatable secret. API keys can't create API
//     keys — that would let a leaked key self-propagate.
//   - Every other /api/v1 route uses Bearer dmk_live_… tokens issued
//     by /api/v1/keys. Touch timestamps on every authenticated call.

import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';

import { createPendingArchivePurchase, ArchiveUnavailableError } from '../archive-purchase.js';
import { validateSafePublicHttpUrl } from '../safe-url.js';
import {
  SignedEventSchema,
  bookmarkEventToJson,
  publishToRelays,
  queryRelaysWithTimeout,
} from '../api-helpers.js';
import type { Deps } from '../route-deps.js';

export function register(deps: Deps): void {
  const {
    app,
    apiKeys,
    accounts,
    purchases,
    relayPool,
    lnd,
    redis,
    meili,
    rateLimit,
    requireNip98,
    PUBLIC_BASE_URL,
    INDEXER_RELAY_URL_FOR_API,
  } = deps;

  /** Returns the authenticated pubkey + key hash, or sends 401 and returns null. */
  async function authenticateApiKey(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ pubkey: string; hash: string } | null> {
    const header = request.headers.authorization;
    // Case-insensitive scheme check; slice length is fixed regardless of
    // whether the caller wrote "Bearer", "bearer", or "BEARER".
    const schemeMatch = header ? /^bearer\s+/i.exec(header) : null;
    if (!schemeMatch) {
      reply.status(401).send({ error: 'missing Bearer token' });
      return null;
    }
    const token = header!.slice(schemeMatch[0].length).trim();
    const record = await apiKeys.lookup(token);
    if (!record) {
      reply.status(401).send({ error: 'invalid or revoked api key' });
      return null;
    }
    // Fire-and-forget; 60s coalescing inside touch() keeps Redis happy.
    apiKeys.touch(record.hash).catch(() => {});
    return { pubkey: record.pubkey, hash: record.hash };
  }

  // ── POST /api/v1/keys — create (NIP-98 + lifetime-tier gate) ─────────
  app.post('/api/v1/keys', async (request, reply) => {
    const authCheck = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/api/v1/keys`,
      'POST',
    );
    if (!authCheck) return;
    const pubkey = authCheck.pubkey;

    // Cap key minting per pubkey. A leaked nsec (or a buggy script) can
    // otherwise spray Redis with thousands of dmk_live_… records that
    // each cost a token-table row + a hash-table row to maintain. 5/hour
    // is generous for human use (rotate, label, recreate) and absurd for
    // any legitimate automation.
    const gate = await rateLimit('apikey-mint', pubkey, 5, 60 * 60);
    if (!gate.ok) {
      reply.header('Retry-After', String(gate.retryAfter));
      return reply.status(429).send({ error: 'rate limit (key mint)', retryAfter: gate.retryAfter });
    }

    const isLifetime = await accounts.isLifetimeMember(pubkey);
    if (!isLifetime) {
      return reply.status(402).send({
        error: 'api access is available to lifetime-tier members (21,000 sats)',
        upgradeUrl: `${PUBLIC_BASE_URL}/pricing`,
      });
    }

    const parsed = z.object({ label: z.string().max(120).optional() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const { plaintext, record } = await apiKeys.create(pubkey, parsed.data.label ?? 'unnamed');
    return reply.status(201).send({
      // Plaintext is returned EXACTLY ONCE. Client must surface the
      // "save this now" UX since we don't keep a copy.
      key: plaintext,
      id: record.hash,
      label: record.label,
      createdAt: record.createdAt,
    });
  });

  // ── GET /api/v1/keys — list my keys (metadata only) ──────────────────
  app.get('/api/v1/keys', async (request, reply) => {
    const authCheck = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/api/v1/keys`,
      'GET',
    );
    if (!authCheck) return;
    const list = await apiKeys.listByPubkey(authCheck.pubkey);
    return {
      keys: list.map((k) => ({
        id: k.hash,
        label: k.label,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
      })),
    };
  });

  // ── DELETE /api/v1/keys/:id — revoke / rotate ────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/api/v1/keys/:id',
    async (request, reply) => {
      const authCheck = await requireNip98(
        request,
        reply,
        `${PUBLIC_BASE_URL}/api/v1/keys/${request.params.id}`,
        'DELETE',
      );
      if (!authCheck) return;
      const ok = await apiKeys.revoke(authCheck.pubkey, request.params.id);
      if (!ok) return reply.status(404).send({ error: 'key not found' });
      return { ok: true };
    },
  );

  // ── GET /api/v1/bookmarks — list / search my PUBLIC bookmarks ──────
  // Private bookmarks (NIP-51 kind:30003 sets) are encrypted client-side
  // and are intentionally NOT exposed through this endpoint or anywhere
  // else under /api/v1/*. The server has no way to decrypt them.
  //
  // Two modes:
  //   - "fancy" search → q OR multiple tags OR offset present → routes
  //     through Meilisearch with a hard `author_pubkey = me` filter so
  //     the user only ever sees their own bookmarks.
  //   - "simple" list → no search params → relay query for the freshest
  //     events (Meili indexes on a small lag).
  //
  // `tag` may be repeated for AND-filter (?tag=rust&tag=async).
  app.get<{
    Querystring: { q?: string; limit?: string; offset?: string; tag?: string | string[]; archived?: string };
  }>('/api/v1/bookmarks', async (request, reply) => {
    const auth = await authenticateApiKey(request, reply);
    if (!auth) return;
    const limit = Math.min(Math.max(Number(request.query.limit ?? 200), 1), 500);
    const offset = Math.min(Math.max(Number(request.query.offset ?? 0), 0), 10_000);
    const tags = normalizeTagsParam(request.query.tag);
    const q = (request.query.q ?? '').trim();
    const archivedOnly = request.query.archived === 'true';
    const useMeili = q.length > 0 || tags.length > 1 || offset > 0;

    if (useMeili) {
      // Per-pubkey rate limit on the search-shaped path. Meili search
      // is heavier than a relay subscribe; a leaked key shouldn't be
      // able to pin Meili by paginating endlessly.
      const gate = await rateLimit('apikey-search', auth.pubkey, 60, 60);
      if (!gate.ok) {
        reply.header('Retry-After', String(gate.retryAfter));
        return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
      }
      const delistedEventIds = new Set<string>(
        (await redis.smembers('dm:blocked-events')) ?? [],
      );
      const result = await meili.search({
        q,
        author: auth.pubkey,
        tags: tags.length > 0 ? tags : undefined,
        limit,
        offset,
        delistedEventIds,
      });
      // archived=true filter is honored on the simple-list path (which
      // sees the kind:39701 archive-tier tag directly) but not here —
      // Meili's index doesn't store it. Callers who need archive
      // status while searching should fetch each result via the relay.
      const bookmarks = result.hits.map((h) => meiliHitToBookmarkJson(h.doc));
      return { bookmarks, count: bookmarks.length, total: result.total, mode: 'search' as const };
    }

    // Simple list — straight from the relay so the very latest writes
    // show up before Meili's indexer has caught up.
    const filters: { kinds: number[]; authors: string[]; limit: number; '#t'?: string[] } = {
      kinds: [39701],
      authors: [auth.pubkey],
      limit,
    };
    if (tags.length === 1) filters['#t'] = [tags[0]!];

    const relays = [INDEXER_RELAY_URL_FOR_API];
    const events = await queryRelaysWithTimeout(relayPool, relays, filters, 2000);
    let list = events.map(bookmarkEventToJson);
    if (archivedOnly) list = list.filter((b) => b.archivedForever);
    return { bookmarks: list, count: list.length, mode: 'list' as const };
  });

  // ── GET /api/v1/search/public — search EVERYONE's public bookmarks ─
  // Same query language as /search/public on the public web, namespaced
  // under /api/v1 + Bearer-gated for per-key rate limits and analytics.
  // Only returns kind:39701 (public) events; private content has no
  // representation in Meili.
  app.get<{
    Querystring: {
      q?: string;
      tag?: string | string[];
      author?: string;
      site?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/v1/search/public', async (request, reply) => {
    const auth = await authenticateApiKey(request, reply);
    if (!auth) return;
    const gate = await rateLimit('apikey-search', auth.pubkey, 60, 60);
    if (!gate.ok) {
      reply.header('Retry-After', String(gate.retryAfter));
      return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
    }
    const tags = normalizeTagsParam(request.query.tag);
    const q = (request.query.q ?? '').trim();
    const limit = Math.min(Math.max(Number(request.query.limit ?? 50), 1), 100);
    const offset = Math.min(Math.max(Number(request.query.offset ?? 0), 0), 10_000);
    const author = request.query.author && /^[0-9a-f]{64}$/i.test(request.query.author)
      ? request.query.author.toLowerCase()
      : undefined;
    const site = typeof request.query.site === 'string' && request.query.site.length <= 253
      ? request.query.site.trim().toLowerCase() || undefined
      : undefined;
    const delistedEventIds = new Set<string>(
      (await redis.smembers('dm:blocked-events')) ?? [],
    );
    const result = await meili.search({
      q, author, site,
      tags: tags.length > 0 ? tags : undefined,
      limit, offset,
      delistedEventIds,
    });
    return {
      hits: result.hits.map((h) => ({
        bookmark: meiliHitToBookmarkJson(h.doc),
        score: h.score,
      })),
      total: result.total,
      query_time_ms: result.query_time_ms,
    };
  });

  // ── POST /api/v1/bookmarks — publish a pre-signed kind:39701 ─────────
  app.post('/api/v1/bookmarks', async (request, reply) => {
    const auth = await authenticateApiKey(request, reply);
    if (!auth) return;
    const parsed = SignedEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid event', details: parsed.error.flatten() });
    }
    const event = parsed.data as NostrEvent;
    if (event.kind !== 39701) {
      return reply.status(400).send({ error: 'expected kind:39701 (public web bookmark)' });
    }
    if (event.pubkey !== auth.pubkey) {
      return reply.status(403).send({ error: 'event pubkey does not match api key owner' });
    }
    if (!verifyEvent(event)) {
      return reply.status(400).send({ error: 'event signature does not verify' });
    }
    // d-tag is the URL and must be present (NIP-B0).
    const dTag = event.tags.find((t) => t[0] === 'd' && typeof t[1] === 'string' && t[1]);
    if (!dTag) return reply.status(400).send({ error: 'kind:39701 requires a d-tag with the URL' });
    // Reject anything that isn't a plain http(s) URL — same posture as
    // the public bookmark publish path. Stops javascript:/data:/file:
    // URLs from landing on the indexer relay.
    try { validateSafePublicHttpUrl(dTag[1]!); }
    catch { return reply.status(400).send({ error: 'd-tag must be a public http(s) URL' }); }
    // Reject events stamped far in the future — they'd sort first
    // forever on relays that order by created_at, drowning real
    // bookmarks. Past timestamps are fine (legitimate historic imports
    // from Pinboard etc.). 10 minutes of future skew covers the worst
    // wall clocks we've seen in the wild.
    if (!isReasonableCreatedAt(event.created_at)) {
      return reply.status(400).send({ error: 'created_at must not be more than 10 minutes in the future' });
    }

    const relays = [INDEXER_RELAY_URL_FOR_API];
    const { ok, failed } = await publishToRelays(relayPool, relays, event, 3000);
    return { eventId: event.id, publishedTo: ok, failedRelays: failed };
  });

  // ── DELETE /api/v1/bookmarks/:eventId — publish a pre-signed kind:5 ──
  app.delete<{ Params: { eventId: string } }>(
    '/api/v1/bookmarks/:eventId',
    async (request, reply) => {
      const auth = await authenticateApiKey(request, reply);
      if (!auth) return;
      // Reject non-hex / wrong-length event IDs at the door so they
      // never reach the e-tag match or hit relays as garbage.
      if (!/^[0-9a-f]{64}$/i.test(request.params.eventId)) {
        return reply.status(400).send({ error: 'eventId must be 64-char lowercase hex' });
      }
      const parsed = SignedEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid deletion event — body must be a signed kind:5 event',
          details: parsed.error.flatten(),
        });
      }
      const event = parsed.data as NostrEvent;
      if (event.kind !== 5) {
        return reply.status(400).send({ error: 'expected kind:5 deletion event' });
      }
      if (event.pubkey !== auth.pubkey) {
        return reply.status(403).send({ error: 'event pubkey does not match api key owner' });
      }
      if (!verifyEvent(event)) {
        return reply.status(400).send({ error: 'event signature does not verify' });
      }
      if (!isReasonableCreatedAt(event.created_at)) {
        return reply.status(400).send({ error: 'created_at must not be more than 10 minutes in the future' });
      }
      const targetsMatch = event.tags.some(
        (t) => t[0] === 'e' && t[1] === request.params.eventId,
      );
      if (!targetsMatch) {
        return reply.status(400).send({
          error: 'deletion event must have an e-tag matching the route parameter',
        });
      }
      const relays = [INDEXER_RELAY_URL_FOR_API];
      const { ok, failed } = await publishToRelays(relayPool, relays, event, 3000);
      return { eventId: event.id, publishedTo: ok, failedRelays: failed };
    },
  );

  /** True when `createdAt` is in seconds-since-epoch and not more than
   *  10 minutes ahead of the server clock. Past timestamps are allowed
   *  (Pinboard imports, scripted backfills) — only future-skew is the
   *  concern, since on relays that sort by created_at a 2099 event
   *  would drown legitimate ones. */
  function isReasonableCreatedAt(createdAt: number): boolean {
    if (!Number.isInteger(createdAt) || createdAt <= 0) return false;
    const now = Math.floor(Date.now() / 1000);
    return createdAt <= now + 10 * 60;
  }

  // ── POST /api/v1/archives — initiate archive purchase invoice ────────
  // Delegates to the existing /archive/purchase flow so we don't duplicate
  // the Voltage + Redis plumbing. Clients then pay the invoice and poll
  // /api/v1/archives/:jobId for status.
  app.post('/api/v1/archives', async (request, reply) => {
    const auth = await authenticateApiKey(request, reply);
    if (!auth) return;
    // Reuse the same SSRF-safe URL refinement as the public route so an
    // API-key holder can't aim the worker at internal targets.
    const parsed = z
      .object({
        url: z.string().max(2000).refine(
          (raw) => { try { validateSafePublicHttpUrl(raw); return true; } catch { return false; } },
          { message: 'url must be a public http(s) URL' },
        ),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    // Rate limit by pubkey + by API-key id. Even though the key is
    // authenticated, a leaked key shouldn't be able to drain Voltage.
    const pkGate = await rateLimit('archive-pk', auth.pubkey, 10, 60);
    if (!pkGate.ok) {
      reply.header('Retry-After', String(pkGate.retryAfter));
      return reply.status(429).send({ error: 'rate limit (pubkey)', retryAfter: pkGate.retryAfter });
    }
    const keyGate = await rateLimit('archive-apikey', auth.hash, 30, 60);
    if (!keyGate.ok) {
      reply.header('Retry-After', String(keyGate.retryAfter));
      return reply.status(429).send({ error: 'rate limit (api key)', retryAfter: keyGate.retryAfter });
    }
    try {
      const result = await createPendingArchivePurchase({
        lnd,
        purchases,
        url: parsed.data.url,
        userPubkey: auth.pubkey,
      });
      return {
        jobId: result.paymentHash,
        invoice: result.invoice,
        amountSats: result.amountSats,
        expiresInSeconds: result.expiresInSeconds,
      };
    } catch (err) {
      if (err instanceof ArchiveUnavailableError) {
        return reply.status(503).send({ error: err.message });
      }
      app.log.error({ err }, 'api archive purchase failed');
      return reply.status(502).send({ error: 'could not create invoice' });
    }
  });

  // ── GET /api/v1/archives/:jobId — poll job status ────────────────────
  app.get<{ Params: { jobId: string } }>(
    '/api/v1/archives/:jobId',
    async (request, reply) => {
      const auth = await authenticateApiKey(request, reply);
      if (!auth) return;
      const record = await purchases.get(request.params.jobId);
      if (!record) return reply.status(404).send({ error: 'job not found' });
      if (record.userPubkey !== auth.pubkey) {
        return reply.status(404).send({ error: 'job not found' });
      }
      return { jobId: request.params.jobId, state: record.status };
    },
  );

  // ── GET /api/v1/archives — list MY completed archives ──────────────
  // Returns the records dropped into dm:archives:<pubkey> by the
  // archive-callback success path. This is "shipped archives" — for
  // in-flight/pending jobs, callers poll /api/v1/archives/:jobId.
  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/api/v1/archives',
    async (request, reply) => {
      const auth = await authenticateApiKey(request, reply);
      if (!auth) return;
      const limit = Math.min(Math.max(Number(request.query.limit ?? 100), 1), 500);
      const offset = Math.min(Math.max(Number(request.query.offset ?? 0), 0), 10_000);
      // Pubkey-keyed redis hash; safe to enumerate, scoped by ownership.
      const raw = await redis.hgetall(`dm:archives:${auth.pubkey}`);
      const items: Array<{
        jobId: string;
        url: string;
        blobHash: string;
        tier: string;
        source?: string;
        archivedAt: number;
      }> = [];
      for (const [blobHash, json] of Object.entries(raw ?? {})) {
        try {
          const rec = JSON.parse(json) as {
            jobId?: string; url?: string; blobHash?: string;
            tier?: string; source?: string; archivedAt?: number;
            ownerPubkey?: string;
          };
          // Defence in depth — these were written keyed by pubkey but
          // double-check in case of corruption / future schema drift.
          if (rec.ownerPubkey && rec.ownerPubkey !== auth.pubkey) continue;
          items.push({
            jobId: rec.jobId ?? '',
            url: rec.url ?? '',
            blobHash: rec.blobHash ?? blobHash,
            tier: rec.tier ?? 'unknown',
            source: rec.source,
            archivedAt: rec.archivedAt ?? 0,
          });
        } catch {
          // Skip corrupt entries — never crash the list handler.
        }
      }
      items.sort((a, b) => b.archivedAt - a.archivedAt);
      const page = items.slice(offset, offset + limit);
      return { archives: page, count: page.length, total: items.length };
    },
  );
}

/** Pull tag query params into a normalized string[]. Accepts ?tag=a&tag=b
 *  (Fastify hands us an array) and ?tag=a (single string). Trims, drops
 *  empty/oversized entries, dedups. */
function normalizeTagsParam(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of arr) {
    const trimmed = t.trim().toLowerCase();
    if (!trimmed || trimmed.length > 64) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  // Cap so a malicious caller can't build a 1000-tag AND filter that
  // pins Meili.
  return out.slice(0, 16);
}

/** Convert a Meili BookmarkDoc into a stable JSON shape for API
 *  callers. The Meili index only stores the fields needed for search
 *  ranking — archive-tier / blossom / wayback / published_at aren't
 *  there. Callers who need those should fetch the underlying event
 *  via the relay (or use the simple-list path of GET /api/v1/bookmarks
 *  which goes straight to the relay and preserves all tags). */
function meiliHitToBookmarkJson(doc: import('../search.js').BookmarkDoc): {
  id: string; pubkey: string; url: string; title: string; description: string;
  tags: string[]; savedAt: number; saveCount: number; zapTotal: number;
} {
  return {
    id: doc.id,
    pubkey: doc.author_pubkey,
    url: doc.url,
    title: doc.title || doc.url,
    description: doc.description ?? '',
    tags: Array.isArray(doc.tags) ? doc.tags.filter((t): t is string => typeof t === 'string') : [],
    savedAt: doc.created_at ?? 0,
    saveCount: doc.save_count ?? 0,
    zapTotal: doc.zap_total ?? 0,
  };
}
