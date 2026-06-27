// Onboarding scanner — fires once per pubkey when it's added to the
// registry. Pulls any existing Deepmarks-shaped events the user has
// already published from other clients (kind:39701 public bookmarks
// + kind:30003 chunked private sets) and forwards them to our relay.
//
// Without this, a Damus / Primal / Amethyst user who'd been bookmarking
// to their own NIP-65 set before signing up for Deepmarks would see
// an empty bookmark list on first login. The scan recovers their
// existing data with zero manual work.
//
// Queues:
//   dm:onboarding:priority-queue — active authenticated-user refreshes.
//   dm:onboarding:queue          — first registration / one-time backfill.
// Both use LPUSH + RPOP FIFO order. The worker checks the priority queue
// before every normal item so active logins are not stuck behind a large
// operator backfill.

import { SimplePool, type Event as NostrEvent } from 'nostr-tools';
import { Redis } from 'ioredis';
import { normalizeRelayUrl, queryWithTimeout } from '../relay-helpers.js';
import {
  allowBookmarkedNoteTargets as allowBookmarkedNoteTargetIds,
  collectBookmarkedNoteTargets,
  fetchBookmarkedKind1Targets,
} from '../bookmarked-note-targets.js';

const QUEUE = 'dm:onboarding:queue';
const PRIORITY_QUEUE = 'dm:onboarding:priority-queue';
const SCAN_MARKER_PREFIX = 'dm:onboarding:done:';
/** Relays we try to discover the user's NIP-65 from when our own
 *  relay doesn't have it yet (brand-new user, first ever sign-in). */
const NIP65_DISCOVERY_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.wine',
  'wss://nostr.land',
];
const NIP65_TIMEOUT_MS = 4_000;
const SCAN_TIMEOUT_MS = 8_000;
const MAX_EVENTS_PER_PUBKEY = 5_000;
const FORWARD_TIMEOUT_MS = 4_000;
const MAX_NOTE_TARGETS_PER_PUBKEY = 5_000;
const MAX_NOTE_TARGET_QUERY_RELAYS = 12;

export interface OnboardingScannerDeps {
  redis: Redis;
  /** Local strfry URL we forward imported events to (ws://strfry:7777
   *  on Box A). The forwarded events are already signed by the user,
   *  so strfry treats them like any other publish — they pass the
   *  writePolicy since the user just got registered. */
  localRelayUrl: string;
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

export class OnboardingScannerWorker {
  private pool?: SimplePool;
  private outbound?: SimplePool;
  /** Dedicated Redis connection for BRPOP. ioredis serializes
   *  commands per connection; a blocking BRPOP on the shared
   *  client would freeze every other Redis op in api
   *  (rate-limit checks, cache reads, etc.). Workers that block
   *  MUST own their own connection. */
  private blockingRedis?: Redis;
  private stopping = false;
  public stats = { scanned: 0, imported: 0, skipped: 0, failed: 0 };

  constructor(private readonly deps: OnboardingScannerDeps) {}

  async start(): Promise<void> {
    this.pool = new SimplePool();
    this.outbound = new SimplePool();
    this.blockingRedis = this.deps.redis.duplicate();
    this.deps.logger.info({ queue: QUEUE, priorityQueue: PRIORITY_QUEUE }, 'onboarding scanner starting');
    // Don't await — runs forever
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.pool?.close([]);
    this.outbound?.destroy();
    this.blockingRedis?.disconnect();
    this.blockingRedis = undefined;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        if (!this.blockingRedis) break;
        const priority = await this.blockingRedis.rpop(PRIORITY_QUEUE);
        const next = priority ? [PRIORITY_QUEUE, priority] : await this.blockingRedis.brpop(PRIORITY_QUEUE, QUEUE, 30);
        if (!next || this.stopping) continue;
        const pubkey = next[1].toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(pubkey)) continue;
        await this.scan(pubkey).catch((err) =>
          this.deps.logger.error({ err, pubkey }, 'onboarding scan failed'),
        );
      } catch (err) {
        // brpop can error if Redis connection blips; back off a moment.
        if (!this.stopping) {
          this.deps.logger.warn({ err }, 'onboarding loop brpop error — backing off');
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    }
  }

  private async scan(pubkey: string): Promise<void> {
    const markerKey = SCAN_MARKER_PREFIX + pubkey;
    const claimed = await this.deps.redis.set(markerKey, '1', 'EX', 30 * 24 * 60 * 60, 'NX');
    if (claimed !== 'OK') {
      this.stats.skipped += 1;
      return; // already scanned
    }

    this.stats.scanned += 1;
    const startedAt = Date.now();

    // 1. Find the user's NIP-65 read relays. Try our relay first,
    //    fall back to common public relays.
    const ourRelay = this.deps.localRelayUrl;
    let relays = await this.fetchNip65(pubkey, [ourRelay]);
    if (relays.length === 0) {
      relays = await this.fetchNip65(pubkey, NIP65_DISCOVERY_RELAYS);
    }
    if (relays.length === 0) {
      this.deps.logger.info({ pubkey }, 'onboarding: no NIP-65 found — nothing to import');
      return;
    }

    // 2. Query those relays for the user's bookmark- and social-shape
    //    events. Kinds we care about:
    //      39701 — Deepmarks-native public web bookmarks
    //      10003 — NIP-51 single bookmark list (Damus/Primal/
    //              Amethyst/Snort all pin notes here)
    //      30000 — NIP-51 categorized follow sets, including the
    //              Deepmarks friends subset
    //      30003 — NIP-51 bookmark sets. Keep public and encrypted-only
    //              sets so Amethyst/Primal/Damus private bookmark lists
    //              can be mirrored as ciphertext and decrypted locally.
    //      30001 — legacy/deprecated NIP-51 "categorized bookmarks/sets".
    //              Older clients (2023–2024 Amethyst/Nostrudel) wrote
    //              bookmark sets here with d:"bookmark"; mirror them like
    //              30003 so those users don't see an empty list.
    //      10002 — NIP-65 relay list. Fanout reads this from our relay
    //              after the user publishes through Deepmarks.
    //      3      — NIP-02 contact list. Required for @-mention
    //              autocomplete: the follows-ingester worker only
    //              watches OUR relay for kind:3, so users whose
    //              contact list was published on Damus/Primal would
    //              otherwise show an empty contacts list. Importing
    //              kind:3 on first sign-in seeds dm:follows:by-user
    //              for the autocomplete to filter against.
    //      0      — kind:0 profile metadata. Same reasoning — the
    //              profile-resolver subscribes to OUR relay; without
    //              this, autocomplete entries show no name + picture
    //              for users whose profile lives elsewhere.
    const events = await queryWithTimeout(
      this.pool!,
      relays,
      { kinds: [39701, 10003, 30000, 30003, 30001, 10002, 3, 0], authors: [pubkey], limit: MAX_EVENTS_PER_PUBKEY },
      SCAN_TIMEOUT_MS,
    );
    if (events.length === 0) {
      this.deps.logger.info({ pubkey, relays: relays.length }, 'onboarding: relays had nothing');
      return;
    }
    const deepmarksEvents = events.filter((e) => this.looksLikeDeepmarks(e));
    const targetNotes = await this.fetchBookmarkedNoteTargets(deepmarksEvents, relays);
    if (targetNotes.length > 0) {
      await this.allowBookmarkedNoteTargets(targetNotes.map((event) => event.id));
    }
    const eventsToForward = [...deepmarksEvents, ...targetNotes];

    // 3. Forward each event to our local strfry. They're already
    //    signed, so strfry just runs them through the writePolicy
    //    and persists. Our local fanout worker will pick them up
    //    and propagate back out if the user has them on relays we
    //    haven't seen them on yet.
    let imported = 0;
    let failed = 0;
    for (const event of eventsToForward) {
      try {
        await this.forwardWithTimeout(event);
        imported += 1;
      } catch {
        failed += 1;
      }
    }
    this.stats.imported += imported;
    this.stats.failed += failed;
    this.deps.logger.info(
      { pubkey, imported, failed, durationMs: Date.now() - startedAt },
      'onboarding scan complete',
    );
  }

  private async fetchNip65(pubkey: string, relays: string[]): Promise<string[]> {
    if (!this.pool) return [];
    try {
      const events = await queryWithTimeout(
        this.pool,
        relays,
        { kinds: [10002], authors: [pubkey], limit: 1 },
        NIP65_TIMEOUT_MS,
      );
      const newest = events.length === 0
        ? null
        : events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
      if (!newest) return [];
      return newest.tags
        .filter((t) => t[0] === 'r' && typeof t[1] === 'string')
        .map((t) => normalizeRelayUrl(t[1]!))
        .filter((url): url is string => !!url);
    } catch {
      return [];
    }
  }

  private looksLikeDeepmarks(event: NostrEvent): boolean {
    // kind:39701 is always a public web bookmark — keep all.
    if (event.kind === 39701) return true;
    // kind:10003 is the legacy single bookmark list — keep all.
    // The frontend's createImportedNoteRefsFeed already knows how
    // to render its `e` tags as social-post bookmarks in the
    // /app/posts tab.
    if (event.kind === 10003) return true;
    // kind:30000 is a NIP-51 categorized follow set. Keep it so
    // Deepmarks friends and other standard follow sets survive relay
    // migration.
    if (event.kind === 30000) return true;
    // kind:3 contact list — forward verbatim so follows-ingester
    // populates dm:follows:by-user for the @-mention autocomplete.
    if (event.kind === 3) return true;
    // kind:0 profile metadata — forward so profile-resolver caches
    // the user's display name + picture for autocomplete entries.
    if (event.kind === 0) return true;
    // kind:10002 relay list — forward so relay-fanout can propagate
    // future Deepmarks publishes to the user's existing write relays.
    if (event.kind === 10002) return true;
    // kind:30003 is the NIP-51 bookmark-set kind, and kind:30001 is its
    // deprecated predecessor. Keep both even when all bookmark refs are
    // private/encrypted in `content`; Amethyst and other clients can
    // publish encrypted-only sets with no public e/a/r tags. Require a
    // non-empty `d` tag so we mirror real named sets, not stray events.
    if (event.kind === 30003 || event.kind === 30001) {
      return event.tags.some((t) => t[0] === 'd' && typeof t[1] === 'string' && t[1].length > 0);
    }
    return false;
  }

  private async fetchBookmarkedNoteTargets(listEvents: NostrEvent[], relays: string[]): Promise<NostrEvent[]> {
    const targets = collectBookmarkedNoteTargets(listEvents);
    if (targets.ids.length === 0) return [];
    const queryRelays = Array.from(new Set([
      ...targets.relays,
      ...relays,
      ...NIP65_DISCOVERY_RELAYS,
    ])).slice(0, MAX_NOTE_TARGET_QUERY_RELAYS);
    if (queryRelays.length === 0 || !this.pool) return [];
    return fetchBookmarkedKind1Targets(this.pool, queryRelays, targets.ids, {
      timeoutMs: NIP65_TIMEOUT_MS,
      maxTargets: MAX_NOTE_TARGETS_PER_PUBKEY,
      maxRelays: MAX_NOTE_TARGET_QUERY_RELAYS,
    });
  }

  private async allowBookmarkedNoteTargets(eventIds: string[]): Promise<void> {
    await allowBookmarkedNoteTargetIds(this.deps.redis, eventIds);
  }

  private async forwardWithTimeout(event: NostrEvent): Promise<void> {
    if (!this.outbound) return;
    const promises = this.outbound.publish([this.deps.localRelayUrl], event);
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('forward timeout')), FORWARD_TIMEOUT_MS),
    );
    await Promise.race([Promise.allSettled(promises), timeout]);
  }
}
