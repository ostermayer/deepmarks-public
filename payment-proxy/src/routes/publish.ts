// POST /publish — server-mediated relay publish.
//
// Privacy + UX architecture: every client (web / iOS / extension)
// posts signed events here instead of opening a WebSocket to
// relay.deepmarks.org themselves. Two wins:
//
//   1. The user's IP never appears at the relay event surface. Anyone
//      scraping the relay sees "all events from 172.x.x.x" (us),
//      not the user's residential or mobile IP. The HTTPS POST still
//      reveals an IP to our edge, but that's coupled to API auth
//      requests rather than to public relay events.
//   2. The client doesn't sit waiting for a relay round-trip. The
//      server queues the publish, returns 200 immediately, and a
//      background worker drains the queue against ws://strfry:7777.
//      A flaky relay or slow remote relay no longer blocks the UI;
//      the save feels instant even when the actual publish takes
//      seconds.
//
// Authentication: each event must carry a valid Nostr signature
// (verified server-side via nostr-tools). The signing pubkey must
// already be in the registered set; otherwise the strfry writePolicy
// would reject the event later anyway, so we reject upfront.
//
// The endpoint accepts batches up to 50 events so the private-set
// chunk publish (25+ chunks) lands in one round-trip instead of N.

import { z } from 'zod';
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import type { Deps } from '../route-deps.js';

const SignedEventSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  created_at: z.number().int().nonnegative(),
  kind: z.number().int().nonnegative(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string().regex(/^[0-9a-f]{128}$/),
});

const PublishRequestSchema = z.object({
  events: z.array(SignedEventSchema).min(1).max(50),
});

/** Redis LIST the publish-relay worker drains and forwards to strfry. */
export const PUBLISH_RELAY_QUEUE = 'dm:publish-relay:queue';
/** Hard cap so a stuck worker can't grow the queue without bound. */
const PUBLISH_RELAY_QUEUE_CAP = 50_000;

/** Kinds users may publish through this endpoint. Mirrors the strfry
 *  writePolicy allowlist plus kind:1 (which strfry shadow-rejects but
 *  the fanout worker handles). Anything else is rejected upfront so
 *  the queue stays clean. */
const ACCEPTED_KINDS = new Set([0, 1, 3, 5, 10000, 10002, 10003, 30003, 39701, 9735, 24133]);

export function register(deps: Deps): void {
  const { app, redis, rateLimit, requireNip98, PUBLIC_BASE_URL } = deps;

  app.post('/publish', async (request, reply) => {
    // NIP-98 auth proves the caller controls the pubkey doing the
    // publish. The signature on each event is verified separately
    // below — we use NIP-98 as the rate-limit + abuse-detect surface
    // (one auth event per request, ties the publish to a pubkey we
    // can throttle).
    const auth = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/publish`,
      'POST',
      { bindBody: true },
    );
    if (!auth) return;

    const gate = await rateLimit('publish-pubkey', auth.pubkey, 200, 60);
    if (!gate.ok) {
      reply.header('Retry-After', String(gate.retryAfter));
      return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
    }

    const parsed = PublishRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid payload', detail: parsed.error.message });
    }
    const { events } = parsed.data;

    const accepted: string[] = [];
    const rejected: Array<{ id: string; reason: string }> = [];

    for (const event of events) {
      // Pubkey on the event must match the NIP-98 auth pubkey — a
      // signed-by-someone-else event being relayed by user A is a
      // possible relay attack vector. Either A controls the key
      // (signature passes) or they don't (we reject).
      if (event.pubkey !== auth.pubkey) {
        rejected.push({ id: event.id, reason: 'pubkey mismatch with auth' });
        continue;
      }
      if (!ACCEPTED_KINDS.has(event.kind)) {
        rejected.push({ id: event.id, reason: `kind ${event.kind} not accepted` });
        continue;
      }
      try {
        if (!verifyEvent(event as unknown as NostrEvent)) {
          rejected.push({ id: event.id, reason: 'bad signature' });
          continue;
        }
      } catch (err) {
        rejected.push({ id: event.id, reason: (err as Error).message ?? 'verify failed' });
        continue;
      }
      accepted.push(event.id);
    }

    if (accepted.length === 0) {
      return reply.status(400).send({ error: 'no events accepted', rejected });
    }

    // Push each accepted event onto the publish queue. The worker
    // forwards to ws://strfry:7777, which runs the writePolicy gate
    // (registered-pubkey check, rate limit, kind:1 shadow-reject +
    // fanout). We trim the queue every time so a stuck worker
    // can't grow Redis without bound.
    const pipeline = redis.multi();
    for (const id of accepted) {
      const event = events.find((e) => e.id === id);
      if (!event) continue;
      pipeline.lpush(PUBLISH_RELAY_QUEUE, JSON.stringify(event));
    }
    pipeline.ltrim(PUBLISH_RELAY_QUEUE, 0, PUBLISH_RELAY_QUEUE_CAP - 1);
    await pipeline.exec();

    // Return 202 — the publish is queued, not confirmed. The UI
    // already shows the optimistic state and treats the publish as
    // eventually consistent.
    reply.header('cache-control', 'no-store');
    return reply.status(202).send({
      queued: accepted.length,
      rejected,
      acceptedIds: accepted,
    });
  });
}
