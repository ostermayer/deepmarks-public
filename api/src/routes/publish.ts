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
import { nostrNoteArchiveUrl } from '../nostr-social-refs.js';
import type { Deps } from '../route-deps.js';
import { enqueueLifetimeArchive } from '../archive-purchase.js';
import { claimDefaultArchiveJob, releaseDefaultArchiveJob } from '../archive-dedupe.js';
import { validateSafePublicHttpUrl } from '../safe-url.js';
import {
  cachePublicBookmarkEvent,
  removeCachedPublicBookmarksForDeletion,
} from '../public-bookmark-cache.js';
import { meiliBookmarkDoc } from './public-bookmarks.js';
import { registerPubkey } from '../registry.js';
import { scheduleActiveUserFriendWarmup, warmFollowSource } from '../friend-cache-warmup.js';
import { execOrThrow } from '../redis-exec.js';

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
const ACCEPTED_KINDS = new Set([0, 1, 3, 5, 10000, 10002, 10003, 30000, 30003, 30001, 39701, 9735, 24133]);

export function register(deps: Deps): void {
  const {
    app,
    redis,
    purchases,
    lifetimeStore,
    userSettingsStore,
    gateRateLimit,
    requireNip98,
    PUBLIC_BASE_URL,
  } = deps;

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

    // requireNip98 registers asynchronously for most routes, but this
    // route immediately forwards events into strfry's write-policy gate.
    // Await registration here so a fresh mobile/iOS publish cannot race
    // the relay and get accepted by /publish but rejected by strfry.
    await registerPubkey(redis, auth.pubkey);

    let allowed: boolean;
    try {
      allowed = await gateRateLimit(reply, 'publish-pubkey', auth.pubkey, 200, 60);
    } catch (err) {
      app.log.error({ err, pubkey: auth.pubkey }, 'publish rate gate failed');
      return reply.status(503).send({ error: 'publish service temporarily unavailable' });
    }
    if (!allowed) return reply;

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
    // (relay-allowed-pubkey check, rate limit, kind:1 shadow-reject +
    // fanout). We trim the queue every time so a stuck worker
    // can't grow Redis without bound.
    const pipeline = redis.multi();
    const acceptedEvents: z.infer<typeof SignedEventSchema>[] = [];
    for (const id of accepted) {
      const event = events.find((e) => e.id === id);
      if (!event) continue;
      acceptedEvents.push(event);
      pipeline.lpush(PUBLISH_RELAY_QUEUE, JSON.stringify(event));
    }
    pipeline.ltrim(PUBLISH_RELAY_QUEUE, 0, PUBLISH_RELAY_QUEUE_CAP - 1);
    try {
      await execOrThrow(pipeline);
    } catch (err) {
      app.log.error({ err, queued: acceptedEvents.length }, 'publish queue write failed');
      return reply.status(503).send({ error: 'publish queue temporarily unavailable' });
    }

    await cacheAcceptedPublicBookmarks(acceptedEvents, deps).catch((err) => {
      app.log.warn({ err }, 'publish accepted but public bookmark cache update failed');
    });
    await removeAcceptedPublicBookmarkDeletions(acceptedEvents, deps).catch((err) => {
      app.log.warn({ err }, 'publish accepted but public bookmark cache delete failed');
    });
    await warmFriendCacheForAcceptedEvents(acceptedEvents, deps).catch((err) => {
      app.log.warn({ err }, 'publish accepted but friend cache warmup failed');
    });

    void queueDefaultArchivesForPublishEvents(
      acceptedEvents,
      {
        redis,
        purchases,
        lifetimeStore,
        userSettingsStore,
        logger: app.log,
      },
    );

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

async function warmFriendCacheForAcceptedEvents(
  events: z.infer<typeof SignedEventSchema>[],
  deps: Pick<Deps, 'redis'>,
): Promise<void> {
  const pubkeys = new Set<string>();
  for (const event of events) {
    if (event.kind === 3 || event.kind === 30000) {
      await warmFollowSource(deps.redis, event as unknown as NostrEvent);
      pubkeys.add(event.pubkey);
      continue;
    }
    if (event.kind === 39701 || event.kind === 10003 || event.kind === 30003 || event.kind === 30001) {
      pubkeys.add(event.pubkey);
    }
  }
  await Promise.all([...pubkeys].map((pubkey) => scheduleActiveUserFriendWarmup(deps.redis, pubkey)));
}

async function removeAcceptedPublicBookmarkDeletions(
  events: z.infer<typeof SignedEventSchema>[],
  deps: Pick<Deps, 'redis' | 'meili' | 'app'>,
): Promise<void> {
  const deletions = events.filter((event) => event.kind === 5);
  if (deletions.length === 0) return;
  for (const event of deletions) {
    const removedIds = await removeCachedPublicBookmarksForDeletion(deps.redis, event as unknown as NostrEvent);
    for (const id of removedIds) {
      void deps.meili.delete(id).catch((err) => (
        deps.app.log.warn({ err, eventId: id }, 'publish public bookmark meili delete failed')
      ));
    }
  }
}

async function cacheAcceptedPublicBookmarks(
  events: z.infer<typeof SignedEventSchema>[],
  deps: Pick<Deps, 'redis' | 'blocklist' | 'meili' | 'app'>,
): Promise<void> {
  const publicBookmarks = events.filter((event) => event.kind === 39701);
  if (publicBookmarks.length === 0) return;
  for (const event of publicBookmarks) {
    const url = tagValue(event.tags, 'd');
    if (!url) continue;
    try {
      validateSafePublicHttpUrl(url);
    } catch {
      continue;
    }
    if (await deps.blocklist.isPubkeySuspended(event.pubkey)) continue;
    if (await deps.blocklist.isEventDelisted(event.id)) continue;
    if (await deps.blocklist.isUrlBlocked(url)) continue;
    await cachePublicBookmarkEvent(deps.redis, event as unknown as NostrEvent);
    const doc = await meiliBookmarkDoc(event as unknown as NostrEvent, deps).catch(() => null);
    if (doc) {
      void deps.meili.upsertBatch([doc]).catch((err) => (
        deps.app.log.warn({ err, eventId: event.id }, 'publish public bookmark meili upsert failed')
      ));
    }
  }
}

async function queueDefaultArchivesForPublishEvents(
  events: z.infer<typeof SignedEventSchema>[],
  deps: Pick<Deps, 'redis' | 'purchases' | 'lifetimeStore' | 'userSettingsStore'> & {
    logger: Pick<Deps['app']['log'], 'info' | 'warn'>;
  },
): Promise<void> {
  const archiveEvents = events.filter((event) => event.kind === 39701 || event.kind === 10003 || event.kind === 30003 || event.kind === 30001);
  if (archiveEvents.length === 0) return;
  const pubkeys = new Set(archiveEvents.map((event) => event.pubkey));
  for (const pubkey of pubkeys) {
    try {
      if (!(await deps.lifetimeStore.isPaid(pubkey))) continue;
      const settings = await deps.userSettingsStore.get(pubkey);
      const archiveByDefault = settings.archiveAllByDefault || !settings.archiveDefaultManualOverride;
      if (!archiveByDefault) continue;
      const relays = settings.backupBlossomServers;
      for (const candidate of archiveCandidates(archiveEvents.filter((event) => event.pubkey === pubkey))) {
        const { event, url, savedAt } = candidate;
        try {
          validateSafePublicHttpUrl(url);
        } catch {
          continue;
        }
        const dedupe = await claimDefaultArchiveJob(deps.redis, pubkey, url);
        if (!dedupe.claimed) continue;
        try {
          await enqueueLifetimeArchive({
            purchases: deps.purchases,
            url,
            userPubkey: pubkey,
            paymentHash: dedupe.jobId,
            eventId: event.id,
            tier: 'public',
            mirrorUrls: relays,
            bookmarkSavedAt: savedAt,
          });
          deps.logger.info({ pubkey, url, jobId: dedupe.jobId }, 'default archive enqueued from /publish');
        } catch (err) {
          await releaseDefaultArchiveJob(deps.redis, pubkey, url, dedupe.jobId).catch(() => undefined);
          deps.logger.warn({ err, pubkey, url }, 'default archive enqueue from /publish failed');
        }
      }
    } catch (err) {
      deps.logger.warn({ err, pubkey }, 'default archive /publish check failed');
    }
  }
}

function archiveCandidates(events: z.infer<typeof SignedEventSchema>[]): Array<{
  event: z.infer<typeof SignedEventSchema>;
  url: string;
  savedAt: number;
}> {
  const out: Array<{ event: z.infer<typeof SignedEventSchema>; url: string; savedAt: number }> = [];
  for (const event of events) {
    const savedAt = bookmarkSavedAt(event);
    if (event.kind === 39701) {
      const url = tagValue(event.tags, 'd');
      if (url) out.push({ event, url, savedAt });
      continue;
    }
    if (event.kind !== 10003 && event.kind !== 30003 && event.kind !== 30001) continue;
    for (const tag of event.tags) {
      if (tag[0] === 'r' && typeof tag[1] === 'string' && /^https?:\/\//i.test(tag[1])) {
        out.push({ event, url: tag[1], savedAt });
      }
      if (tag[0] === 'e' && typeof tag[1] === 'string') {
        const url = nostrNoteArchiveUrl(tag[1]);
        if (url) out.push({ event, url, savedAt });
      }
    }
  }
  return out;
}

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find((tag) => tag[0] === name)?.[1];
}

function bookmarkSavedAt(event: z.infer<typeof SignedEventSchema>): number {
  const publishedAt = tagValue(event.tags, 'published_at');
  if (publishedAt && /^\d+$/.test(publishedAt)) {
    const parsed = Number(publishedAt);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return event.created_at;
}

