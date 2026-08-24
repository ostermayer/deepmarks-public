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

import { randomUUID } from 'node:crypto';
import { SimplePool, type Event as NostrEvent } from 'nostr-tools';
import type { Redis } from 'ioredis';
import { normalizeRelayUrl, subscribeSingleRelay } from '../relay-helpers.js';
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
  /** Optional operator alerting — dead-lettered events are the only
   *  record that a 202-acknowledged save never reached the relay. */
  alerter?: { alert(opts: { severity: 'critical' | 'warning'; key: string; subject: string; body: string }): Promise<void> };
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
/** Events the worker gave up on (policy-rejected or retries exhausted).
 *  The client already got a 202, so this list is the only record the
 *  save never reached the relay — inspect with LRANGE, re-inject by
 *  LPUSHing the inner `event` back onto dm:publish-relay:queue. */
const PUBLISH_RELAY_DEAD_LETTER_QUEUE = 'dm:publish-relay:dead';
const PUBLISH_RELAY_DEAD_LETTER_CAP = 10_000;
/** Per-worker in-flight list. The drain loop BLMOVEs each event from the
 *  publish queue into `dm:publish-relay:processing:<workerId>` so a crash
 *  between the pop and the forward can't lose a 202-acknowledged save —
 *  recoverPublishRelayOrphans re-queues a dead worker's list on the next
 *  boot. Mirrors the archive queue's crash-safe BLMOVE + recovery pattern. */
const PUBLISH_RELAY_PROCESSING_PREFIX = 'dm:publish-relay:processing:';
/** Same crash-safe shape for the kind:1 fanout queue — its old BRPOP was
 *  destructive, so a crash between the pop and the forward lost a
 *  shadow-rejected note forever (2026-08-23 review). */
const KIND1_FANOUT_PROCESSING_PREFIX = 'dm:kind1-fanout:processing:';
/** Per-worker heartbeat key. Recovery skips a processing list whose worker
 *  is still alive (key present); a dead worker's key expires, so its list
 *  gets reclaimed. */
const PUBLISH_RELAY_ACTIVE_PREFIX = 'dm:publish-relay:active:';
const PUBLISH_RELAY_ACTIVE_TTL_SECONDS = 60;
const PUBLISH_RELAY_HEARTBEAT_INTERVAL_MS = 20_000;
const PUBLISH_RELAY_DELAYED_PROMOTE_BATCH = 100;
const PUBLISH_RELAY_DELAYED_PROMOTE_INTERVAL_MS = 1_000;
const PUBLISH_RELAY_TRANSIENT_BACKOFF_BASE_MS = 1_000;
const PUBLISH_RELAY_TRANSIENT_BACKOFF_MAX_MS = 60_000;
const PUBLISH_RELAY_RATE_LIMIT_BACKOFF_MS = 10 * 60_000;
/** Rate-limited events retry on a much longer budget than transient
 *  failures: with 10min×attempts (capped 60min) backoff this allows a
 *  bulk import to drain over ~24h+ instead of dropping at 8 attempts. */
const PUBLISH_RELAY_RATE_LIMIT_MAX_ATTEMPTS = 30;

export type PublishRelayRetryPlan =
  | { action: 'retry'; delayMs: number; reason: 'rate-limit' | 'transient' }
  | { action: 'drop'; reason: 'attempts-exhausted' | 'policy-rejected' };

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
  /** Random per-process id so a restarted worker's old processing list is
   *  always orphaned (its heartbeat key belongs to the dead id). */
  private readonly publishWorkerId = `w-${randomUUID()}`;
  private publishHeartbeat?: ReturnType<typeof setInterval>;
  private publishRecoveryTimer?: ReturnType<typeof setTimeout>;
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
    this.sub = subscribeSingleRelay(
      this.pool,
      this.deps.relayUrl,
      [{ kinds: [0, 1, 3, 5, 10000, 10002, 10003, 30000, 30003, 39701], since }],
      {
        onevent: (event) => this.handleEvent(event).catch((err) =>
          this.deps.logger.error({ err, eventId: event.id }, 'relay-fanout handleEvent failed')
        ),
      },
      { logError: (obj, msg) => this.deps.logger.error(obj, msg) },
    );

    // Crash recovery: re-queue events a previous (now-dead) worker had
    // BLMOVE'd into its processing list but never finished forwarding.
    void this.recoverPublishRelayOrphans().catch((err) =>
      this.deps.logger.warn({ err }, 'publish-relay orphan recovery failed'));
    void this.recoverKind1FanoutOrphans().catch((err) =>
      this.deps.logger.warn({ err }, 'kind:1 fanout orphan recovery failed'));
    // A worker that crashed just before this boot can still have a live
    // heartbeat TTL, so its list is skipped by the pass above; a second
    // pass after the TTL elapses reclaims it.
    this.publishRecoveryTimer = setTimeout(() => {
      void this.recoverPublishRelayOrphans().catch(() => undefined);
      void this.recoverKind1FanoutOrphans().catch(() => undefined);
    }, (PUBLISH_RELAY_ACTIVE_TTL_SECONDS + 5) * 1_000);
    this.publishRecoveryTimer.unref?.();
    // Heartbeat so peers' recovery skips our own in-flight processing list.
    void this.refreshPublishActive();
    this.publishHeartbeat = setInterval(
      () => { void this.refreshPublishActive(); },
      PUBLISH_RELAY_HEARTBEAT_INTERVAL_MS,
    );
    this.publishHeartbeat.unref?.();

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
    if (this.publishHeartbeat) clearInterval(this.publishHeartbeat);
    if (this.publishRecoveryTimer) clearTimeout(this.publishRecoveryTimer);
    // Leave our heartbeat key to expire on its TTL rather than deleting it:
    // an in-flight item may still be mid-forward as we tear down, and a
    // replacement worker must not reclaim (and double-forward) it until our
    // TTL lapses. Nostr events are id-idempotent, so a late double-forward
    // is harmless, but not racing it is cleaner.
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
    const processingKey = PUBLISH_RELAY_PROCESSING_PREFIX + this.publishWorkerId;
    while (!this.stopping) {
      try {
        if (!this.publishBlockingRedis) break;
        // BLMOVE (not BRPOP): atomically move the event into our per-worker
        // processing list so a crash between the pop and the forward can't
        // lose a 202-acknowledged save. Pop from the tail (oldest — FIFO with
        // the LPUSH in /publish), push to the processing list head.
        const raw = await this.publishBlockingRedis.blmove(
          PUBLISH_RELAY_QUEUE, processingKey, 'RIGHT', 'LEFT', 30,
        );
        // If we're stopping, leave the item in the processing list — the
        // replacement worker's recovery pass re-queues it (no loss).
        if (!raw || this.stopping) continue;
        let event: NostrEvent;
        try { event = JSON.parse(raw) as NostrEvent; }
        catch {
          this.deps.logger.warn('relay-fanout: corrupt publish-relay queue entry — dropping');
          await this.deps.redis.lrem(processingKey, 1, raw).catch(() => undefined);
          continue;
        }
        try {
          if (!this.pool) {
            await this.requeuePublishRelayEvent(event, new Error('relay pool not ready'));
          } else {
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
          }
        } finally {
          // Remove from the processing list only after the event was either
          // forwarded or durably re-queued/dead-lettered above. If the
          // process dies before this LREM, recovery re-queues it and strfry
          // dedupes the re-forward by event id (at-least-once, id-idempotent).
          await this.deps.redis.lrem(processingKey, 1, raw).catch(() => undefined);
        }
      } catch (err) {
        if (!this.stopping) {
          this.deps.logger.warn({ err }, 'publish-relay loop blmove error — backing off');
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    }
  }

  /** Refresh our heartbeat so peers' recovery skips our in-flight list. */
  private async refreshPublishActive(): Promise<void> {
    if (this.stopping) return;
    await this.deps.redis
      .set(PUBLISH_RELAY_ACTIVE_PREFIX + this.publishWorkerId, '1', 'EX', PUBLISH_RELAY_ACTIVE_TTL_SECONDS)
      .catch(() => undefined);
  }

  /** Re-queue events stranded in a dead worker's processing list. A list is
   *  reclaimed only when its worker's heartbeat key is absent (dead/gone). */
  private async recoverPublishRelayOrphans(): Promise<void> {
    let cursor = '0';
    let recovered = 0;
    do {
      const [next, keys] = (await this.deps.redis.scan(
        cursor, 'MATCH', `${PUBLISH_RELAY_PROCESSING_PREFIX}*`, 'COUNT', 100,
      )) as [string, string[]];
      cursor = next;
      for (const key of keys) {
        const wid = key.slice(PUBLISH_RELAY_PROCESSING_PREFIX.length);
        if (wid === this.publishWorkerId) continue; // never reclaim our own live list
        const active = await this.deps.redis.exists(PUBLISH_RELAY_ACTIVE_PREFIX + wid);
        if (active > 0) continue; // worker still alive/draining
        const items = await this.deps.redis.lrange(key, 0, -1);
        if (items.length === 0) { await this.deps.redis.del(key).catch(() => undefined); continue; }
        const pipeline = this.deps.redis.multi();
        // RPUSH to the queue tail preserves processing order and is fair to
        // saves that arrived while the dead worker was down.
        for (const item of items) pipeline.rpush(PUBLISH_RELAY_QUEUE, item);
        pipeline.del(key);
        await execOrThrow(pipeline);
        recovered += items.length;
      }
    } while (cursor !== '0');
    if (recovered > 0) {
      this.deps.logger.warn({ recovered }, 'publish-relay recovered orphaned events from a dead worker');
    }
  }

  /** kind:1 twin of recoverPublishRelayOrphans — kept as a separate copy
   *  on purpose (different queue target; the live recovery path stays
   *  untouched). */
  private async recoverKind1FanoutOrphans(): Promise<void> {
    let cursor = '0';
    let recovered = 0;
    do {
      const [next, keys] = (await this.deps.redis.scan(
        cursor, 'MATCH', `${KIND1_FANOUT_PROCESSING_PREFIX}*`, 'COUNT', 100,
      )) as [string, string[]];
      cursor = next;
      for (const key of keys) {
        const wid = key.slice(KIND1_FANOUT_PROCESSING_PREFIX.length);
        if (wid === this.publishWorkerId) continue;
        const active = await this.deps.redis.exists(PUBLISH_RELAY_ACTIVE_PREFIX + wid);
        if (active > 0) continue;
        const items = await this.deps.redis.lrange(key, 0, -1);
        if (items.length === 0) { await this.deps.redis.del(key).catch(() => undefined); continue; }
        const pipeline = this.deps.redis.multi();
        for (const item of items) pipeline.rpush(KIND1_FANOUT_QUEUE, item);
        pipeline.del(key);
        await execOrThrow(pipeline);
        recovered += items.length;
      }
    } while (cursor !== '0');
    if (recovered > 0) {
      this.deps.logger.warn({ recovered }, 'kind:1 fanout recovered orphaned events from a dead worker');
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
    const processingKey = KIND1_FANOUT_PROCESSING_PREFIX + this.publishWorkerId;
    while (!this.stopping) {
      try {
        if (!this.blockingRedis) break;
        // BLMOVE (not BRPOP) into a per-worker processing list — mirrors
        // runPublishRelayLoop so a crash mid-forward can't lose the note;
        // recovery re-queues it and relays dedupe by event id.
        const raw = await this.blockingRedis.blmove(
          KIND1_FANOUT_QUEUE, processingKey, 'RIGHT', 'LEFT', 30,
        );
        if (!raw || this.stopping) continue;
        let event: NostrEvent;
        try { event = JSON.parse(raw) as NostrEvent; }
        catch {
          this.deps.logger.warn('relay-fanout: corrupt kind:1 queue entry — dropping');
          await this.deps.redis.lrem(processingKey, 1, raw).catch(() => undefined);
          continue;
        }
        try {
          await this.handleKind1Event(event).catch((err) =>
            this.deps.logger.error({ err, eventId: event.id }, 'relay-fanout kind:1 handle failed'),
          );
        } finally {
          await this.deps.redis.lrem(processingKey, 1, raw).catch(() => undefined);
        }
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

    // kind:30003 is the NIP-51 bookmark-set kind. Fan out public and
    // encrypted-only sets; private refs live in `content`, so requiring
    // public e/a/r tags would drop Amethyst-style private bookmarks.
    if (event.kind === 30003) {
      const dTag = event.tags.find((t) => t[0] === 'd')?.[1];
      if (!dTag) return;
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
      // SET NX EX creates the counter WITH its TTL atomically. The old
      // INCR-then-EXPIRE pair could die between the two commands and
      // leave a TTL-less key whose count grew past the limit forever,
      // silently skipping that user's fanout (2026-08-23 review #11).
      await this.deps.redis.set(key, '0', 'EX', PER_PUBKEY_RATE_WINDOW_S, 'NX');
      const count = await this.deps.redis.incr(key);
      // Self-heal counters stranded by the old pattern.
      if (count > PER_PUBKEY_RATE_LIMIT && (await this.deps.redis.ttl(key)) === -1) {
        await this.deps.redis.expire(key, PER_PUBKEY_RATE_WINDOW_S);
      }
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
    // Write-health heartbeat: /health/relay flags the pipeline as wedged
    // when the queue is non-empty but this stamp goes stale.
    await this.deps.redis.set('dm:publish-relay:last-forward-ts', String(Date.now())).catch(() => undefined);
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
        const alertOperator = shouldAlertPublishRelayDeadLetter(plan.reason, err);
        await this.deps.redis.del(attemptsKey).catch(() => undefined);
        // Park the event in a dead-letter list instead of vanishing it —
        // the client already got its 202, so this is the only record
        // that the save never reached the relay.
        await execOrThrow(this.deps.redis.multi()
          .lpush(PUBLISH_RELAY_DEAD_LETTER_QUEUE, JSON.stringify({
            event,
            reason: plan.reason,
            error: err instanceof Error ? err.message : String(err),
            attempts,
            droppedAt: Date.now(),
          }))
          .ltrim(PUBLISH_RELAY_DEAD_LETTER_QUEUE, 0, PUBLISH_RELAY_DEAD_LETTER_CAP - 1))
          .catch(() => undefined);
        const logPayload = { eventId: event.id, kind: event.kind, attempts, reason: plan.reason, alertOperator, err };
        const logMessage = plan.reason === 'policy-rejected'
          ? 'publish-relay forward rejected by policy — dead-lettered'
          : 'publish-relay forward exhausted retries — dead-lettered';
        if (alertOperator) this.deps.logger.error(logPayload, logMessage);
        else this.deps.logger.info(logPayload, 'publish-relay dead-letter recorded without operator alert');
        if (alertOperator) {
          await this.deps.alerter?.alert({
            severity: 'warning',
            key: `publish-relay-dead-letter:${plan.reason}`,
            subject: `relay publish dead-lettered (${plan.reason})`,
            body: `Event ${event.id} (kind ${event.kind}, author ${event.pubkey}) was dead-lettered after ${attempts} attempt(s): ${err instanceof Error ? err.message : String(err)}.\n\nInspect: LRANGE dm:publish-relay:dead 0 20`,
          }).catch(() => undefined);
        }
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
  // Deterministic writePolicy/strfry rejections can never succeed on a
  // re-send of the same bytes — retrying just burns the author's
  // rate-limit window and delays the inevitable. Dead-letter immediately
  // so the drop is visible instead of masked as 8 "transient" retries.
  if (isDeterministicRejectError(err)) {
    return { action: 'drop', reason: 'policy-rejected' };
  }
  if (isRateLimitError(err)) {
    // Rate limiting isn't a failure — the event WILL land once the
    // author's hourly window refills. Give it a much longer budget than
    // transient errors so a bulk import (thousands of bookmarks) drains
    // over hours instead of being dropped at the generic attempt cap.
    if (attempts > PUBLISH_RELAY_RATE_LIMIT_MAX_ATTEMPTS) {
      return { action: 'drop', reason: 'attempts-exhausted' };
    }
    return {
      action: 'retry',
      reason: 'rate-limit',
      delayMs: Math.min(PUBLISH_RELAY_RATE_LIMIT_BACKOFF_MS * attempts, 60 * 60_000),
    };
  }
  if (attempts > PUBLISH_RELAY_MAX_ATTEMPTS) {
    return { action: 'drop', reason: 'attempts-exhausted' };
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

export function shouldAlertPublishRelayDeadLetter(_reason: PublishRelayRetryPlan['reason'], err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // Replaceable events can legitimately lose to a newer event that has
  // already landed. Keep the dead-letter record, but do not email for
  // expected NIP-16 convergence.
  if (/replaced:\s*have newer event/i.test(message) || /\bhave newer event\b/i.test(message)) return false;
  return true;
}

function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\brate[- ]?limit\b|too many requests/i.test(message);
}

/** Rejections that depend only on the event's contents/author — the same
 *  event will be rejected forever, so retrying is pure waste. Matches the
 *  deepmarks.js writePolicy reject strings plus strfry's own created_at
 *  window and validation messages. */
function isDeterministicRejectError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /not registered/i.test(message) ||
    /not accepted on this relay/i.test(message) ||
    /restricted to admin/i.test(message) ||
    /malformed (?:event|request)/i.test(message) ||
    /too old/i.test(message) ||
    /too far in the future/i.test(message) ||
    /creation date is too far off/i.test(message) ||
    /replaced:\s*have newer event/i.test(message) ||
    /\bhave newer event\b/i.test(message)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
