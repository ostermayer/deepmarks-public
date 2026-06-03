// Server-side fan-out worker — pushes Deepmarks events from the
// canonical relay (relay.deepmarks.org / ws://strfry:7777 internally)
// out to each author's NIP-65 advertised write relays.
//
// Lets clients publish to one relay only — fast UX, no waiting on
// flaky third-party relays — while still propagating to Damus,
// Primal, nos.lol, etc. so the events appear on other Nostr clients.
//
// Flow:
//   1. subscribe to ws://strfry:7777 for user-owned state the app
//      publishes through /publish: profile, contacts, mute list,
//      relay list, deletions, bookmarks, and private/archive-key chunks.
//   2. for each event, look up the author's kind:10002 (NIP-65) — read
//      it once from strfry, cache in Redis with a 6h TTL.
//   3. publish the event to each relay in that list (skipping the
//      canonical relay, single-label hosts, and obvious junk).
//
// In-memory LRU dedupes by event id so a relay re-emitting an event
// (e.g. our own NIP-65 fetch round-tripping) doesn't trigger a second
// fan-out. Per-pubkey rate-limit (Redis-backed) caps how aggressively
// we hammer outbound relays for one user — protects us from a
// runaway publish loop if an account starts dumping events.

import { SimplePool, type Event as NostrEvent } from 'nostr-tools';
import type { Redis } from 'ioredis';
import { normalizeRelayUrl } from '../relay-helpers.js';
import { execOrThrow } from '../redis-exec.js';

const NIP65_CACHE_TTL_SECONDS = 6 * 60 * 60;
const NIP65_NEGATIVE_TTL_SECONDS = 5 * 60;
const SEEN_LRU_SIZE = 20_000;
const PER_PUBKEY_RATE_LIMIT = 200; // events fanned-out per pubkey per minute
const PER_PUBKEY_RATE_WINDOW_S = 60;
const OUTBOUND_TIMEOUT_MS = 4_000;
const MAX_TARGET_RELAYS_PER_EVENT = 12;
const PUBLISH_RELAY_QUEUE_CAP = 50_000;
const PUBLISH_RELAY_MAX_ATTEMPTS = 8;
const PUBLISH_RELAY_ATTEMPT_TTL_SECONDS = 24 * 60 * 60;

export interface RelayFanoutDeps {
  redis: Redis;
  /** Internal relay URL the worker reads from (ws://strfry:7777 in prod). */
  relayUrl: string;
  /** Canonical relay URL clients publish TO (wss://relay.deepmarks.org).
   *  Never fan out to ourselves. */
  canonicalRelayUrl: string;
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

/** Redis LIST the strfry writePolicy plugin pushes kind:1 events to.
 *  Strfry doesn't persist these — we want our relay to stay
 *  bookmarks-only — so this is the only path the fanout worker has
 *  to see shadow-rejected notes. Watched friends' link-notes are now
 *  persisted by strfry and fan out through the normal relay
 *  subscription below. */
const KIND1_FANOUT_QUEUE = 'dm:kind1-fanout:queue';

/** Redis LIST POST /publish writes signed events onto. We drain it
 *  here and forward each event to ws://strfry:7777 so the client
 *  never has to talk directly to our relay — every relay event
 *  enters via the server, never via a user IP. */
const PUBLISH_RELAY_QUEUE = 'dm:publish-relay:queue';
const PUBLISH_RELAY_DELAYED_QUEUE = 'dm:publish-relay:delayed';
const PUBLISH_RELAY_DELAYED_PROMOTE_BATCH = 100;
const PUBLISH_RELAY_DELAYED_PROMOTE_INTERVAL_MS = 1_000;
const PUBLISH_RELAY_TRANSIENT_BACKOFF_BASE_MS = 1_000;
const PUBLISH_RELAY_TRANSIENT_BACKOFF_MAX_MS = 60_000;
const PUBLISH_RELAY_RATE_LIMIT_BACKOFF_MS = 10 * 60_000;

export type PublishRelayRetryPlan =
  | { action: 'retry'; delayMs: number; reason: 'rate-limit' | 'transient' }
  | { action: 'drop'; reason: 'attempts-exhausted' };

export class RelayFanoutWorker {
  private pool?: SimplePool;
  private outbound?: SimplePool;
  private sub?: { close: () => void };
  /** Dedicated Redis connection for the kind:1 BRPOP loop. Shared
   *  client + BRPOP would block every other command on that client. */
  private blockingRedis?: Redis;
  private stopping = false;
  private seen = new Set<string>();
  private seenQueue: string[] = [];
  /** Dedicated Redis connection for the publish-relay BRPOP loop.
   *  Same reasoning as blockingRedis above — BRPOP serialises every
   *  other command on the connection. */
  private publishBlockingRedis?: Redis;
  /** Events fanned out + relays attempted, exposed for /admin/relay-stats-style introspection. */
  public stats = {
    fannedOut: 0, skippedSeen: 0, skippedNoNip65: 0, skippedRateLimited: 0,
    publishOk: 0, publishFail: 0,
    kind1FannedOut: 0, kind1SkippedNoNip65: 0,
    publishRelayOk: 0, publishRelayFail: 0,
  };

  constructor(private readonly deps: RelayFanoutDeps) {}

  async start(): Promise<void> {
    this.pool = new SimplePool();
    this.outbound = new SimplePool();
    this.blockingRedis = this.deps.redis.duplicate();
    this.publishBlockingRedis = this.deps.redis.duplicate();
    this.deps.logger.info({ relay: this.deps.relayUrl }, 'relay-fanout worker starting');

    // Only watch events from the moment we start. Historical events
    // already in strfry don't need re-fanning; if a user wants their
    // backlog re-broadcast they can re-save (which republishes
    // chunks).
    const since = Math.floor(Date.now() / 1000);
    // Watch all user-owned Nostr state that arrives via /publish.
    // Bookmark-shaped kinds still get special filtering below; the
    // rest are replaceable/profile/delete events that should follow
    // the user's NIP-65 relay list because clients no longer publish
    // directly from the browser/app to third-party relays.
    this.sub = this.pool.subscribeMany(
      [this.deps.relayUrl],
      { kinds: [0, 1, 3, 5, 10000, 10002, 10003, 30000, 30003, 39701], since },
      {
        onevent: (event) => this.handleEvent(event).catch((err) =>
          this.deps.logger.error({ err, eventId: event.id }, 'relay-fanout handleEvent failed')
        ),
      },
    );

    // Promote durable delayed retries back onto the server-mediated
    // publish queue, then drain the queue — every signed event
    // posted to /publish lands here. Forward each one to our local
    // strfry over a SimplePool publish so the user's IP never
    // touches the relay surface.
    void this.runPublishRelayDelayLoop();
    void this.runPublishRelayLoop();

    // Separate loop for kind:1 events. The writePolicy plugin pushes
    // them onto the Redis queue (not into strfry's LMDB), so the WS
    // subscription above will never see them.
    void this.runKind1Loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.sub?.close();
    this.pool?.close([this.deps.relayUrl]);
    this.outbound?.destroy();
    this.blockingRedis?.disconnect();
    this.blockingRedis = undefined;
    this.publishBlockingRedis?.disconnect();
    this.publishBlockingRedis = undefined;
  }

  /** Drain dm:publish-relay:queue (the server-mediated publish queue
   *  populated by POST /publish) and forward each signed event to
   *  ws://strfry:7777. Strfry's writePolicy still runs (registered-
   *  pubkey gate, rate limits, kind:1 shadow-reject + fanout) — this
   *  worker is just the privacy-preserving transport. */
  private async runPublishRelayLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        if (!this.publishBlockingRedis) break;
        const next = await this.publishBlockingRedis.brpop(PUBLISH_RELAY_QUEUE, 30);
        if (!next || this.stopping) continue;
        let event: NostrEvent;
        try { event = JSON.parse(next[1]) as NostrEvent; }
        catch {
          this.deps.logger.warn('relay-fanout: corrupt publish-relay queue entry — dropping');
          continue;
        }
        if (!this.pool) {
          await this.requeuePublishRelayEvent(event, new Error('relay pool not ready'));
          continue;
        }
        try {
          // Publish to our local strfry. SimplePool fans out to the
          // single relay URL we give it and resolves the promise on
          // OK from strfry. A 4s timeout matches the rest of the
          // worker's outbound contract.
          await this.publishWithTimeout(this.pool, [this.deps.relayUrl], event, OUTBOUND_TIMEOUT_MS);
          await this.clearPublishRelayAttempts(event.id);
          this.stats.publishRelayOk += 1;
        } catch (err) {
          this.stats.publishRelayFail += 1;
          this.deps.logger.warn(
            { err, eventId: event.id, kind: event.kind },
            'publish-relay forward to strfry failed',
          );
          await this.requeuePublishRelayEvent(event, err);
        }
      } catch (err) {
        if (!this.stopping) {
          this.deps.logger.warn({ err }, 'publish-relay loop brpop error — backing off');
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    }
  }

  private async runPublishRelayDelayLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.promoteDuePublishRelayEvents();
      } catch (err) {
        this.deps.logger.warn({ err }, 'publish-relay delayed retry promotion failed');
      }
      await sleep(PUBLISH_RELAY_DELAYED_PROMOTE_INTERVAL_MS);
    }
  }

  private async promoteDuePublishRelayEvents(now = Date.now()): Promise<number> {
    const due = await this.deps.redis.zrangebyscore(
      PUBLISH_RELAY_DELAYED_QUEUE,
      '-inf',
      now,
      'LIMIT',
      0,
      PUBLISH_RELAY_DELAYED_PROMOTE_BATCH,
    );
    if (due.length === 0) return 0;
    const pipeline = this.deps.redis.multi();
    for (const item of due) pipeline.lpush(PUBLISH_RELAY_QUEUE, item);
    pipeline.zrem(PUBLISH_RELAY_DELAYED_QUEUE, ...due);
    pipeline.ltrim(PUBLISH_RELAY_QUEUE, 0, PUBLISH_RELAY_QUEUE_CAP - 1);
    await execOrThrow(pipeline);
    return due.length;
  }

  /** Long-running BRPOP loop draining the kind:1 fanout queue that the
   *  strfry writePolicy plugin populates. Each item is the raw JSON
   *  event the publisher signed; we look up the author's NIP-65 write
   *  relays and broadcast to them (skipping our own relay since the
   *  event was never persisted there anyway). */
  private async runKind1Loop(): Promise<void> {
    while (!this.stopping) {
      try {
        if (!this.blockingRedis) break;
        const next = await this.blockingRedis.brpop(KIND1_FANOUT_QUEUE, 30);
        if (!next || this.stopping) continue;
        let event: NostrEvent;
        try { event = JSON.parse(next[1]) as NostrEvent; }
        catch {
          this.deps.logger.warn('relay-fanout: corrupt kind:1 queue entry — dropping');
          continue;
        }
        await this.handleKind1Event(event).catch((err) =>
          this.deps.logger.error({ err, eventId: event.id }, 'relay-fanout kind:1 handle failed'),
        );
      } catch (err) {
        if (!this.stopping) {
          this.deps.logger.warn({ err }, 'relay-fanout kind:1 loop brpop error — backing off');
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    }
  }

  private async handleKind1Event(event: NostrEvent): Promise<void> {
    // Rate-limit per pubkey (same window as the bookmark path) so a
    // runaway client can't burn outbound bandwidth.
    if (!(await this.allowFanoutFor(event.pubkey))) {
      this.stats.skippedRateLimited += 1;
      return;
    }
    const targets = await this.targetsFor(event.pubkey);
    if (targets.length === 0) {
      this.stats.kind1SkippedNoNip65 += 1;
      this.deps.logger.info(
        { eventId: event.id, pubkey: event.pubkey },
        'kind:1 fanout: no NIP-65 relays — note will not reach other clients',
      );
      return;
    }
    this.stats.kind1FannedOut += 1;
    for (const url of targets) void this.publishOne(url, event);
  }

  private async handleEvent(event: NostrEvent): Promise<void> {
    if (this.seen.has(event.id)) {
      this.stats.skippedSeen += 1;
      return;
    }
    this.markSeen(event.id);

    // kind:30003 is generic — only fan-out Deepmarks-shape sets
    // (our private, archive-keys, and NWC sync chunks) and any kind:30003 that
    // looks like a bookmark list (has at least one `e`/`a`/`r` tag).
    // Skip random NIP-51 sets clients use for unrelated purposes
    // (mute lists, pin lists, etc.) so we don't spam outbound
    // relays with the user's full Nostr state.
    if (event.kind === 30003) {
      const dTag = event.tags.find((t) => t[0] === 'd')?.[1];
      if (!dTag) return;
      const looksDeepmarks =
        dTag === 'deepmarks-private' ||
        /^deepmarks-private-\d+$/.test(dTag) ||
        dTag === 'deepmarks-archive-keys' ||
        dTag === 'deepmarks-nwc';
      const hasBookmarkRefs = event.tags.some(
        (t) => t[0] === 'e' || t[0] === 'a' || t[0] === 'r',
      );
      if (!looksDeepmarks && !hasBookmarkRefs) return;
    }
    // kind:30000 is a standard NIP-51 follow set. Deepmarks uses
    // d=deepmarks-friends for the friends subset, but generic follow
    // sets are still harmless user-authored state and should follow
    // the user's NIP-65 relay list.
    if (event.kind === 30000) {
      const hasDTag = event.tags.some((t) => t[0] === 'd' && typeof t[1] === 'string' && t[1].length > 0);
      if (!hasDTag) return;
    }
    // kind:10003 is always a bookmark list by definition. Fan out
    // unconditionally.

    if (!(await this.allowFanoutFor(event.pubkey))) {
      this.stats.skippedRateLimited += 1;
      return;
    }

    const targets = await this.targetsFor(event.pubkey);
    if (targets.length === 0) {
      this.stats.skippedNoNip65 += 1;
      return;
    }

    this.stats.fannedOut += 1;
    // Fire-and-forget per target. SimplePool handles connection
    // pooling so subsequent events to the same relay reuse the WS.
    for (const url of targets) {
      void this.publishOne(url, event);
    }
  }

  private async targetsFor(pubkey: string): Promise<string[]> {
    const cacheKey = `dm:relay-fanout:nip65:${pubkey}`;
    const cached = await this.deps.redis.get(cacheKey).catch(() => null);
    if (cached !== null) {
      try {
        const parsed = JSON.parse(cached) as string[];
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // Corrupt; fall through to refresh.
      }
    }

    let relays: string[] = [];
    try {
      const events = await this.pool!.querySync(
        [this.deps.relayUrl],
        { kinds: [10002], authors: [pubkey], limit: 1 },
      );
      const newest = events.length === 0
        ? null
        : events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
      if (newest) {
        relays = newest.tags
          .filter((t) => t[0] === 'r' && typeof t[1] === 'string')
          .filter((t) => {
            const marker = (t[2] ?? '').toLowerCase();
            return marker === '' || marker === 'write';
          })
          .map((t) => normalizeRelayUrl(t[1]!))
          .filter((url): url is string => !!url)
          .filter((url) => !this.isOurRelay(url));
        // de-dup + cap
        relays = Array.from(new Set(relays)).slice(0, MAX_TARGET_RELAYS_PER_EVENT);
      }
    } catch (err) {
      this.deps.logger.warn({ err, pubkey }, 'relay-fanout NIP-65 lookup failed');
    }

    const ttl = relays.length > 0 ? NIP65_CACHE_TTL_SECONDS : NIP65_NEGATIVE_TTL_SECONDS;
    await this.deps.redis.set(cacheKey, JSON.stringify(relays), 'EX', ttl).catch(() => undefined);
    return relays;
  }

  private async allowFanoutFor(pubkey: string): Promise<boolean> {
    const key = `dm:relay-fanout:rl:${pubkey}`;
    try {
      const count = await this.deps.redis.incr(key);
      if (count === 1) await this.deps.redis.expire(key, PER_PUBKEY_RATE_WINDOW_S);
      return count <= PER_PUBKEY_RATE_LIMIT;
    } catch {
      // Redis down — fail open so user events still propagate.
      return true;
    }
  }

  private async publishOne(url: string, event: NostrEvent): Promise<void> {
    if (!this.outbound) return;
    try {
      // SimplePool.publish returns Promise<string>[] — one per relay
      await this.publishWithTimeout(this.outbound, [url], event, OUTBOUND_TIMEOUT_MS);
      this.stats.publishOk += 1;
    } catch {
      this.stats.publishFail += 1;
    }
  }

  private async publishWithTimeout(
    pool: SimplePool,
    relays: string[],
    event: NostrEvent,
    timeoutMs: number,
  ): Promise<void> {
    const publishes = pool.publish(relays, event);
    if (publishes.length === 0) {
      throw new Error('publish returned no relay promises');
    }
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`publish timeout after ${timeoutMs}ms`)), timeoutMs),
    );
    const results = await Promise.race([
      Promise.allSettled(publishes),
      timeout,
    ]);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length === results.length) {
      const reason = failures
        .map((r) => r.reason instanceof Error ? r.reason.message : String(r.reason))
        .join('; ');
      throw new Error(reason || 'all relay publishes rejected');
    }
  }

  private async requeuePublishRelayEvent(event: NostrEvent, err: unknown): Promise<void> {
    const attemptsKey = `dm:publish-relay:attempts:${event.id}`;
    try {
      const attempts = await this.deps.redis.incr(attemptsKey);
      if (attempts === 1) {
        await this.deps.redis.expire(attemptsKey, PUBLISH_RELAY_ATTEMPT_TTL_SECONDS);
      }
      const plan = planPublishRelayRetry(attempts, err);
      if (plan.action === 'drop') {
        await this.deps.redis.del(attemptsKey).catch(() => undefined);
        this.deps.logger.error(
          { eventId: event.id, kind: event.kind, attempts, err },
          'publish-relay forward exhausted retries — dropping event',
        );
        return;
      }
      const runAt = Date.now() + plan.delayMs;
      await execOrThrow(this.deps.redis.multi()
        .zadd(PUBLISH_RELAY_DELAYED_QUEUE, runAt, JSON.stringify(event))
        .zremrangebyrank(PUBLISH_RELAY_DELAYED_QUEUE, PUBLISH_RELAY_QUEUE_CAP, -1));
      this.deps.logger.warn(
        { eventId: event.id, kind: event.kind, attempts, delayMs: plan.delayMs, reason: plan.reason },
        'publish-relay forward scheduled for retry',
      );
    } catch (redisErr) {
      this.deps.logger.error(
        { redisErr, eventId: event.id, kind: event.kind },
        'publish-relay failed and could not requeue event',
      );
    }
  }

  private async clearPublishRelayAttempts(eventId: string): Promise<void> {
    await this.deps.redis.del(`dm:publish-relay:attempts:${eventId}`).catch(() => undefined);
  }

  private isOurRelay(url: string): boolean {
    const norm = normalizeRelayUrl(url);
    const ours = normalizeRelayUrl(this.deps.canonicalRelayUrl);
    if (!norm || !ours) return false;
    if (norm === ours) return true;
    // Cover the docker-internal alias as well.
    if (norm === 'ws://strfry:7777') return true;
    return false;
  }

  private markSeen(id: string): void {
    this.seen.add(id);
    this.seenQueue.push(id);
    if (this.seenQueue.length > SEEN_LRU_SIZE) {
      const evicted = this.seenQueue.shift();
      if (evicted) this.seen.delete(evicted);
    }
  }
}

export function planPublishRelayRetry(attempts: number, err: unknown): PublishRelayRetryPlan {
  if (attempts > PUBLISH_RELAY_MAX_ATTEMPTS) {
    return { action: 'drop', reason: 'attempts-exhausted' };
  }
  if (isRateLimitError(err)) {
    return {
      action: 'retry',
      reason: 'rate-limit',
      delayMs: Math.min(PUBLISH_RELAY_RATE_LIMIT_BACKOFF_MS * attempts, 60 * 60_000),
    };
  }
  return {
    action: 'retry',
    reason: 'transient',
    delayMs: Math.min(
      PUBLISH_RELAY_TRANSIENT_BACKOFF_BASE_MS * (2 ** Math.max(0, attempts - 1)),
      PUBLISH_RELAY_TRANSIENT_BACKOFF_MAX_MS,
    ),
  };
}

function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\brate[- ]?limit\b|too many requests/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
