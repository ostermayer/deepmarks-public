// Lifetime-archive backfill worker — fires once when a user is newly
// stamped as a lifetime member. Walks their cached public bookmarks
// and enqueues an archive job for each one that doesn't have a
// blossom hash or wayback URL yet.
//
// Previously this only ran client-side via lib/nostr/lifetime-archive-
// backfill.ts. That required the user to open the web app or iOS app
// after settlement; lifetime users who upgraded via BTCPay and never
// opened a Deepmarks surface would never get their backlog archived.
// Running it server-side closes that gap.
//
// Queue: dm:lifetime-archive:queue (LIST). lifetime.markPaid LPUSHes
// the pubkey on first settlement; this worker BRPOP-loops.

import { Redis } from 'ioredis';
import { type Event as NostrEvent } from 'nostr-tools';
import { nostrNoteArchiveUrl } from '../nostr-social-refs.js';
import { enqueueLifetimeBackfillCandidate } from '../archive-lifecycle.js';
import { listCachedPublicBookmarks } from '../public-bookmark-cache.js';
import { queryWithTimeout } from '../relay-helpers.js';
import type { PurchaseStore } from '../queue.js';

const QUEUE = 'dm:lifetime-archive:queue';
const SCAN_MARKER_PREFIX = 'dm:lifetime-archive:done:';
/** Cap per-pubkey enqueue. Heavy importers can have 4000+ bookmarks
 *  — sending them all at once would saturate Box B's archive queue
 *  and starve newer saves from getting through. The client-side
 *  backfill already handles the long tail; this server-side path
 *  just bootstraps the first batch so the user sees progress
 *  immediately. */
const MAX_ENQUEUE_PER_PUBKEY = 250;

export interface LifetimeArchiveBackfillDeps {
  redis: Redis;
  purchases: PurchaseStore;
  /** Internal strfry URL we query for the user's NIP-51 bookmark lists.
   *  Lifetime members get their NIP-51 URLs and note refs auto-archived alongside
   *  the kind:39701 Deepmarks-native bookmarks. */
  relayUrl: string;
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

export class LifetimeArchiveBackfillWorker {
  private stopping = false;
  /** Dedicated Redis connection for BRPOP. See the note on
   *  OnboardingScannerWorker.blockingRedis for why a shared client
   *  is wrong here. */
  private blockingRedis?: Redis;
  public stats = { processed: 0, enqueued: 0, skipped: 0, failed: 0 };

  constructor(private readonly deps: LifetimeArchiveBackfillDeps) {}

  async start(): Promise<void> {
    this.blockingRedis = this.deps.redis.duplicate();
    this.deps.logger.info({ queue: QUEUE }, 'lifetime-archive backfill worker starting');
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.blockingRedis?.disconnect();
    this.blockingRedis = undefined;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        if (!this.blockingRedis) break;
        const next = await this.blockingRedis.brpop(QUEUE, 30);
        if (!next || this.stopping) continue;
        const pubkey = next[1].toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(pubkey)) continue;
        await this.run(pubkey).catch((err) =>
          this.deps.logger.error({ err, pubkey }, 'lifetime-archive backfill failed'),
        );
      } catch (err) {
        if (!this.stopping) {
          this.deps.logger.warn({ err }, 'lifetime-archive loop brpop error — backing off');
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    }
  }

  private async run(pubkey: string): Promise<void> {
    const markerKey = SCAN_MARKER_PREFIX + pubkey;
    const claimed = await this.deps.redis.set(markerKey, '1', 'EX', 365 * 24 * 60 * 60, 'NX');
    if (claimed !== 'OK') {
      this.stats.skipped += 1;
      return; // already processed
    }
    this.stats.processed += 1;

    const startedAt = Date.now();
    let enqueued = 0;
    let failed = 0;
    let skipped = 0;

    // De-dup across both sources so the same URL appearing in
    // kind:39701 AND kind:10003 doesn't queue two archives.
    const seenUrls = new Set<string>();

    const bookmarks = await listCachedPublicBookmarks(this.deps.redis, pubkey, MAX_ENQUEUE_PER_PUBKEY);
    for (const bookmark of bookmarks) {
      if (bookmark.blossomHash || bookmark.archivedForever || bookmark.waybackUrl) {
        skipped += 1;
        continue;
      }
      if (seenUrls.has(bookmark.url)) {
        skipped += 1;
        continue;
      }
      seenUrls.add(bookmark.url);
      const outcome = await enqueueLifetimeBackfillCandidate({
        redis: this.deps.redis,
        purchases: this.deps.purchases,
        pubkey,
        url: bookmark.url,
        eventId: bookmark.id,
        bookmarkSavedAt: bookmark.savedAt,
        warn: (obj, msg) => this.deps.logger.warn(obj, msg),
      });
      if (outcome === 'enqueued') enqueued += 1;
      else if (outcome === 'failed') failed += 1;
      else skipped += 1;
    }

    // NIP-51 bookmark lists can store direct URLs in `r` tags and
    // kind:1/social bookmarks in `e` tags. Archive both forms so a
    // lifetime member's post bookmarks get the same durable treatment
    // as ordinary web pages.
    const remaining = Math.max(0, MAX_ENQUEUE_PER_PUBKEY - enqueued);
    if (remaining > 0 && !this.stopping) {
      const urls = await this.collectNip51ArchiveUrls(pubkey);
      for (const { url, eventId, savedAt } of urls) {
        if (enqueued >= MAX_ENQUEUE_PER_PUBKEY) break;
        if (seenUrls.has(url)) { skipped += 1; continue; }
        seenUrls.add(url);
        const outcome = await enqueueLifetimeBackfillCandidate({
          redis: this.deps.redis,
          purchases: this.deps.purchases,
          pubkey,
          url,
          eventId,
          bookmarkSavedAt: savedAt,
          warn: (obj, msg) => this.deps.logger.warn(obj, msg),
        });
        if (outcome === 'enqueued') enqueued += 1;
        else if (outcome === 'failed') failed += 1;
        else skipped += 1;
      }
    }

    this.stats.enqueued += enqueued;
    this.stats.failed += failed;
    this.stats.skipped += skipped;
    this.deps.logger.info(
      { pubkey, enqueued, failed, skipped, durationMs: Date.now() - startedAt },
      'lifetime-archive backfill complete',
    );
  }

  /** Pull the user's latest NIP-51 bookmark lists from our relay and
   *  extract both URL bookmarks (`r`) and kind:1 note bookmarks (`e`).
   *  Note refs archive their canonical public note page so they can be
   *  listed, sorted, and opened from Archives like normal web saves. */
  private async collectNip51ArchiveUrls(pubkey: string): Promise<Array<{
    url: string;
    eventId?: string;
    savedAt?: number;
  }>> {
    if (this.stopping) return [];
    try {
      const events = await queryWithTimeout(
        [this.deps.relayUrl],
        { kinds: [10003, 30003], authors: [pubkey], limit: 100 },
        5_000,
      );
      if (events.length === 0) return [];

      // NIP-51 lists are replaceable/parameterized replaceable. Keep the
      // latest event per replaceable coordinate.
      const latestByList = new Map<string, NostrEvent>();
      for (const event of events as NostrEvent[]) {
        const key = event.kind === 30003
          ? `${event.kind}:${event.pubkey}:${event.tags.find((t) => t[0] === 'd')?.[1] ?? ''}`
          : `${event.kind}:${event.pubkey}`;
        const existing = latestByList.get(key);
        if (!existing || event.created_at > existing.created_at) latestByList.set(key, event);
      }

      const byUrl = new Map<string, { url: string; eventId?: string; savedAt?: number }>();
      for (const event of latestByList.values()) {
        const savedAt = publishedAt(event) ?? event.created_at;
        for (const tag of event.tags) {
          if (tag[0] === 'r' && typeof tag[1] === 'string') {
            const url = tag[1].trim();
            if (/^https?:\/\//i.test(url) && !byUrl.has(url)) {
              byUrl.set(url, { url, eventId: event.id, savedAt });
            }
          }
          if (tag[0] === 'e' && typeof tag[1] === 'string') {
            const url = nostrNoteArchiveUrl(tag[1]);
            if (url && !byUrl.has(url)) byUrl.set(url, { url, eventId: event.id, savedAt });
          }
        }
      }
      return [...byUrl.values()];
    } catch (err) {
      this.deps.logger.warn({ err, pubkey }, 'NIP-51 bookmark list fetch failed');
      return [];
    }
  }
}

function publishedAt(event: NostrEvent): number | undefined {
  const raw = event.tags.find((tag) => tag[0] === 'published_at')?.[1];
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

