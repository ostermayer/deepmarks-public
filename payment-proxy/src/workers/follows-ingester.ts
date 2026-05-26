// Server-side outbox: for every contact-list event on our relay, the
// followers' followed pubkeys are tracked; we then connect to each
// followed pubkey's NIP-65 write relays and ingest their kind:39701 /
// 30003 / 10003 events into our local strfry. We also mirror kind:1
// notes that contain http(s) links so /app/friends can show friend
// links posted from Primal/Damus/etc. without becoming a social feed.
//
// The user-facing payoff: the client only ever talks to relay.deepmarks.org.
// The server does the federation work — outbox-model reads against
// third-party relays, ingestion into our store — so the iOS app /
// browser extension never has to hold open WebSockets to flaky third-
// party relays just to read someone they follow.
//
// Pipeline:
//
//   1. Subscribe to our local strfry for kind:3 events (NIP-02 contact
//      lists). For each, extract the followed-pubkey set from `p` tags
//      and store under dm:follows:by-user:<follower>. Also union into
//      dm:contacts:watched (the global set of pubkeys we should
//      ingest content for).
//
//   2. Periodically (every ~10 minutes), pick a batch of watched
//      pubkeys whose last ingest was longest ago. For each:
//        a. Look up their NIP-65 (kind:10002) — try our relay first,
//           fall back to common public discovery relays. Cache the
//           resulting URL list in Redis (24h TTL).
//        b. Query their write relays for kinds [39701, 30003, 10003]
//           with a small since-window (since=last-ingest-time minus
//           buffer) so we don't re-pull events we already have.
//           Separately query kind:1 and forward only notes with http(s)
//           links; the UI strips the note text and renders only links.
//        c. Forward each event to ws://strfry:7777. Strfry's
//           writePolicy plugin gates on the AUTHOR being in
//           dm:registered:pubkeys — so we sad-path register the
//           followed pubkey before forwarding (any pubkey that a
//           Deepmarks user follows is implicitly trusted enough to
//           store their public events).
//        d. Stamp dm:contacts:last-ingest:<pubkey> so the next pick
//           cycle skips them.
//
// Resource caps:
//   - Max relays open at once (bounded batches + guarded raw WS reads)
//   - Per-batch ingest cap on number of curators (BATCH_SIZE)
//   - Per-curator event cap (MAX_EVENTS_PER_CURATOR)
//   - Min interval between re-ingests for the same curator
//     (MIN_INGEST_INTERVAL_MS) so we don't burn outbound bandwidth
//     re-fetching the same curator every loop.

import { SimplePool, type Event as NostrEvent } from 'nostr-tools';
import { Redis } from 'ioredis';
import { queryWithTimeout, normalizeRelayUrl } from '../relay-helpers.js';

const FOLLOWS_BY_USER_PREFIX = 'dm:follows:by-user:';
const CONTACTS_WATCHED_SET = 'dm:contacts:watched';
const CONTACTS_LAST_INGEST_PREFIX = 'dm:contacts:last-ingest:';
const NIP65_CACHE_PREFIX = 'dm:follows-ingester:nip65:';
const NIP65_CACHE_TTL_S = 24 * 60 * 60;
const NIP65_NEGATIVE_TTL_S = 60 * 60;
/** Public relays we fall back to when our own relay doesn't have a
 *  curator's kind:10002 yet. Kept short — the moment we DO have it,
 *  cache hits the curator-specific list directly. */
const NIP65_DISCOVERY_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.wine',
];
const QUERY_TIMEOUT_MS = 4_000;
const FORWARD_TIMEOUT_MS = 4_000;
const MAX_EVENTS_PER_CURATOR = 500;
const MAX_SOCIAL_NOTES_PER_CURATOR = 300;
const MIN_INGEST_INTERVAL_MS = 30 * 60 * 1000; // 30 min
const BATCH_SIZE = 50;
const BATCH_INTERVAL_MS = 10 * 60 * 1000; // 10 min
const MAX_TARGET_RELAYS_PER_CURATOR = 8;
/** How often we re-fetch each relay-allowed pubkey's kind:3 + kind:0 from
 *  their NIP-65 relays. Users update their contact list on Damus /
 *  Primal etc.; we want autocomplete to stay current without
 *  hammering third-party relays. 6h matches our profile-cache TTL. */
const RELAY_ALLOWED_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RELAY_ALLOWED_SYNC_LAST_PREFIX = 'dm:contacts:sync:last:';
const RELAY_ALLOWED_PUBKEYS_SET = 'dm:registered:pubkeys';
/** Don't try to sync every relay-allowed pubkey every cycle — cap so the
 *  worker stays responsive even if the allowlist grows large. */
const MAX_RELAY_ALLOWED_SYNCS_PER_CYCLE = 100;

export interface FollowsIngesterDeps {
  redis: Redis;
  /** Internal strfry URL — we both subscribe (kind:3 watcher) and
   *  forward ingested events here. */
  relayUrl: string;
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

export class FollowsIngesterWorker {
  private contactsPool?: SimplePool;
  private outboundPool?: SimplePool;
  private localPool?: SimplePool;
  private sub?: { close: () => void };
  private batchTimer?: NodeJS.Timeout;
  private stopping = false;
  /** Dedicated Redis connection for any blocking ops (we don't do
   *  BRPOP today, but a duplicate keeps us future-proof and isolates
   *  this worker from any incidental blocking call). */
  private blockingRedis?: Redis;

  public stats = {
    contactListsSeen: 0,
    curatorsTracked: 0,
    ingestsRun: 0,
    eventsForwarded: 0,
    forwardFailures: 0,
  };

  constructor(private readonly deps: FollowsIngesterDeps) {}

  async start(): Promise<void> {
    this.contactsPool = new SimplePool();
    this.outboundPool = new SimplePool();
    this.localPool = new SimplePool();
    this.blockingRedis = this.deps.redis.duplicate();
    this.deps.logger.info({ relay: this.deps.relayUrl }, 'follows-ingester worker starting');

    // Watch kind:3 contact lists from relay-allowed pubkeys. In
    // practice, user contact lists are the ones we act on; curator
    // contact lists may also appear because followed curators are
    // allowlisted for mirrored public bookmarks.
    this.sub = this.contactsPool.subscribeMany(
      [this.deps.relayUrl],
      { kinds: [3] },
      {
        onevent: (event) =>
          this.handleContactList(event).catch((err) =>
            this.deps.logger.error({ err }, 'follows-ingester handleContactList failed'),
          ),
      },
    );

    // Kick off the first ingest pass after a short delay so the
    // contact-list sub has time to populate the watched set on a
    // fresh boot.
    this.batchTimer = setTimeout(() => this.runBatch(), 30_000);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.sub?.close();
    this.contactsPool?.close([this.deps.relayUrl]);
    this.outboundPool?.destroy();
    this.localPool?.destroy();
    this.blockingRedis?.disconnect();
  }

  private async handleContactList(event: NostrEvent): Promise<void> {
    const follower = event.pubkey.toLowerCase();
    const followed = new Set<string>();
    for (const t of event.tags) {
      if (t[0] !== 'p' || typeof t[1] !== 'string') continue;
      const pk = t[1].toLowerCase();
      if (/^[0-9a-f]{64}$/.test(pk) && pk !== follower) followed.add(pk);
    }
    this.stats.contactListsSeen += 1;
    if (followed.size === 0) return;

    // Replace the follower's known follows set wholesale — kind:3 is
    // replaceable, so the latest event is authoritative.
    const userKey = FOLLOWS_BY_USER_PREFIX + follower;
    const pipeline = this.deps.redis.multi();
    pipeline.del(userKey);
    pipeline.sadd(userKey, ...Array.from(followed));
    pipeline.expire(userKey, 30 * 24 * 60 * 60); // 30d so a deleted account eventually drops out
    // Union into the watched set so the batch picker can find them.
    pipeline.sadd(CONTACTS_WATCHED_SET, ...Array.from(followed));
    await pipeline.exec().catch(() => undefined);
  }

  private async runBatch(): Promise<void> {
    if (this.stopping) return;
    try {
      const candidates = await this.pickBatch();
      if (candidates.length === 0) {
        this.deps.logger.info('follows-ingester: nothing to ingest this cycle');
      } else {
        this.deps.logger.info({ batchSize: candidates.length }, 'follows-ingester: ingesting batch');
        for (const pubkey of candidates) {
          if (this.stopping) break;
          await this.ingestCurator(pubkey).catch((err) =>
            this.deps.logger.warn({ err, pubkey }, 'follows-ingester ingestCurator failed'),
          );
        }
      }
      // Second pass: refresh each relay-allowed pubkey's own kind:3
      // contact list + kind:0 profile from their NIP-65 relays so
      // the @-mention autocomplete stays current as users update
      // their follows in other Nostr clients.
      await this.syncRelayAllowedContacts().catch((err) =>
        this.deps.logger.warn({ err }, 'follows-ingester syncRelayAllowedContacts failed'),
      );
    } catch (err) {
      this.deps.logger.error({ err }, 'follows-ingester batch errored');
    } finally {
      if (!this.stopping) {
        this.batchTimer = setTimeout(() => this.runBatch(), BATCH_INTERVAL_MS);
      }
    }
  }

  /** Refresh kind:3 + kind:0 for relay-allowed pubkeys from their NIP-65
   *  relays. Skips pubkeys whose last sync was within
   *  RELAY_ALLOWED_SYNC_INTERVAL_MS. Caps total per cycle so a
   *  growing allowlist doesn't extend the batch indefinitely. */
  private async syncRelayAllowedContacts(): Promise<void> {
    const all = await this.deps.redis.smembers(RELAY_ALLOWED_PUBKEYS_SET).catch(() => [] as string[]);
    if (all.length === 0) return;
    const now = Date.now();
    const pubkeys = all.filter((pk) => /^[0-9a-f]{64}$/.test(pk));
    const pipeline = this.deps.redis.pipeline();
    for (const pk of pubkeys) pipeline.get(RELAY_ALLOWED_SYNC_LAST_PREFIX + pk);
    const results = (await pipeline.exec()) ?? [];
    const stamped = pubkeys.map((pubkey, i) => {
      const [, value] = results[i] ?? [null, null];
      const lastSync = typeof value === 'string' ? Number(value) : 0;
      return { pubkey, lastSync: Number.isFinite(lastSync) ? lastSync : 0 };
    });
    const due = stamped
      .filter((s) => now - s.lastSync >= RELAY_ALLOWED_SYNC_INTERVAL_MS)
      .sort((a, b) => a.lastSync - b.lastSync)
      .slice(0, MAX_RELAY_ALLOWED_SYNCS_PER_CYCLE);

    if (due.length === 0) return;
    this.deps.logger.info({ count: due.length }, 'follows-ingester: syncing relay-allowed kind:3 + kind:0');
    for (const { pubkey } of due) {
      if (this.stopping) break;
      try {
        await this.syncOneRelayAllowedPubkey(pubkey);
      } catch (err) {
        this.deps.logger.warn({ err, pubkey }, 'follows-ingester syncOneRelayAllowedPubkey failed');
      }
    }
  }

  private async syncOneRelayAllowedPubkey(pubkey: string): Promise<void> {
    const relays = await this.curatorRelays(pubkey);
    if (relays.length === 0) {
      // No NIP-65 → can't sync from network. Stamp anyway so we
      // don't retry on every cycle.
      await this.deps.redis
        .set(RELAY_ALLOWED_SYNC_LAST_PREFIX + pubkey, String(Date.now()))
        .catch(() => undefined);
      return;
    }
    const events = await queryWithTimeout(
      this.outboundPool!,
      relays,
      { kinds: [3, 0], authors: [pubkey], limit: 4 },
      QUERY_TIMEOUT_MS,
    );
    for (const event of events) {
      if (this.stopping) break;
      try {
        await this.forward(event);
        this.stats.eventsForwarded += 1;
      } catch {
        this.stats.forwardFailures += 1;
      }
    }
    await this.deps.redis
      .set(RELAY_ALLOWED_SYNC_LAST_PREFIX + pubkey, String(Date.now()))
      .catch(() => undefined);
  }

  private async pickBatch(): Promise<string[]> {
    // Take all watched pubkeys, sort by lastIngest asc, pick the
    // oldest BATCH_SIZE. SMEMBERS is O(N) but N is bounded by the
    // sum of followers' follows-counts, realistically thousands.
    const all = await this.deps.redis.smembers(CONTACTS_WATCHED_SET).catch(() => [] as string[]);
    if (all.length === 0) return [];
    const now = Date.now();
    const pubkeys = all.filter((pk) => /^[0-9a-f]{64}$/.test(pk));
    // Read last-ingest timestamps in bulk via pipeline.
    const pipeline = this.deps.redis.pipeline();
    for (const pk of pubkeys) pipeline.get(CONTACTS_LAST_INGEST_PREFIX + pk);
    const results = (await pipeline.exec()) ?? [];
    const stamped: Array<{ pubkey: string; lastIngest: number }> = pubkeys.map((pubkey, i) => {
      const [, value] = results[i] ?? [null, null];
      const lastIngest = typeof value === 'string' ? Number(value) : 0;
      return { pubkey, lastIngest: Number.isFinite(lastIngest) ? lastIngest : 0 };
    });
    return stamped
      .filter((s) => now - s.lastIngest >= MIN_INGEST_INTERVAL_MS)
      .sort((a, b) => a.lastIngest - b.lastIngest)
      .slice(0, BATCH_SIZE)
      .map((s) => s.pubkey);
  }

  private async ingestCurator(pubkey: string): Promise<void> {
    this.stats.curatorsTracked += 1;
    // Register the curator so the writePolicy doesn't bounce their
    // events when we forward them. Anyone our users follow is by
    // extension trusted enough to store on our relay.
    const { registerPubkey } = await import('../registry.js');
    await registerPubkey(this.deps.redis, pubkey).catch(() => undefined);

    const relays = await this.curatorRelays(pubkey);
    if (relays.length === 0) {
      // No relays advertised — try the discovery set so a brand-new
      // followed pubkey still gets ingested.
      relays.push(...NIP65_DISCOVERY_RELAYS);
    }

    const lastIngest = Number(
      (await this.deps.redis.get(CONTACTS_LAST_INGEST_PREFIX + pubkey)) ?? '0',
    );
    const since = lastIngest > 0
      ? Math.floor(lastIngest / 1000) - 60 // 1 min overlap for safety
      : Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60; // first pass: last 30 days

    const bookmarkEvents = await queryWithTimeout(
      this.outboundPool!,
      relays,
      { kinds: [39701, 30003, 10003], authors: [pubkey], since, limit: MAX_EVENTS_PER_CURATOR },
      QUERY_TIMEOUT_MS,
    );
    const socialLinkNotes = (await queryWithTimeout(
      this.outboundPool!,
      relays,
      { kinds: [1], authors: [pubkey], since, limit: MAX_SOCIAL_NOTES_PER_CURATOR },
      QUERY_TIMEOUT_MS,
    )).filter((event) => hasHttpUrl(event.content));

    const events = [...bookmarkEvents, ...socialLinkNotes];
    if (events.length === 0) {
      await this.deps.redis.set(CONTACTS_LAST_INGEST_PREFIX + pubkey, String(Date.now())).catch(() => undefined);
      return;
    }
    this.stats.ingestsRun += 1;
    for (const event of events) {
      if (this.stopping) break;
      try {
        await this.forward(event);
        this.stats.eventsForwarded += 1;
      } catch {
        this.stats.forwardFailures += 1;
      }
    }
    await this.deps.redis.set(CONTACTS_LAST_INGEST_PREFIX + pubkey, String(Date.now())).catch(() => undefined);
  }

  private async curatorRelays(pubkey: string): Promise<string[]> {
    const cacheKey = NIP65_CACHE_PREFIX + pubkey;
    const cached = await this.deps.redis.get(cacheKey).catch(() => null);
    if (cached !== null) {
      try {
        const parsed = JSON.parse(cached) as string[];
        if (Array.isArray(parsed)) return parsed;
      } catch { /* fall through */ }
    }

    let relayList: string[] = [];
    try {
      // Try our own relay first — if the pubkey is relay-allowed + has
      // published kind:10002, it'll be here.
      let events = await queryWithTimeout(
        this.localPool!,
        [this.deps.relayUrl],
        { kinds: [10002], authors: [pubkey], limit: 1 },
        QUERY_TIMEOUT_MS,
      );
      if (events.length === 0) {
        // Fall back to public discovery relays.
        events = await queryWithTimeout(
          this.outboundPool!,
          NIP65_DISCOVERY_RELAYS,
          { kinds: [10002], authors: [pubkey], limit: 1 },
          QUERY_TIMEOUT_MS,
        );
      }
      const newest = events.length === 0
        ? null
        : events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
      if (newest) {
        relayList = newest.tags
          .filter((t) => t[0] === 'r' && typeof t[1] === 'string')
          .map((t) => normalizeRelayUrl(t[1]!))
          .filter((u): u is string => !!u);
        relayList = Array.from(new Set(relayList)).slice(0, MAX_TARGET_RELAYS_PER_CURATOR);
      }
    } catch {
      // Network blip — caller falls back to discovery.
    }
    await this.deps.redis
      .set(cacheKey, JSON.stringify(relayList), 'EX', relayList.length > 0 ? NIP65_CACHE_TTL_S : NIP65_NEGATIVE_TTL_S)
      .catch(() => undefined);
    return relayList;
  }

  private async forward(event: NostrEvent): Promise<void> {
    if (!this.localPool) return;
    const promises = this.localPool.publish([this.deps.relayUrl], event);
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('forward timeout')), FORWARD_TIMEOUT_MS),
    );
    await Promise.race([Promise.allSettled(promises), timeout]);
  }
}

function hasHttpUrl(content: string): boolean {
  return /\bhttps?:\/\/\S+/i.test(content);
}
