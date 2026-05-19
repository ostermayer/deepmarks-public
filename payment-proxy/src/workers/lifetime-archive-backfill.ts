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
import { SimplePool } from 'nostr-tools';
import { listCachedPublicBookmarks } from '../public-bookmark-cache.js';
import { enqueueLifetimeArchive } from '../archive-purchase.js';
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
  /** Internal strfry URL we query for the user's kind:10003 (NIP-51
   *  single bookmark list — Damus/Primal/Amethyst's pin format).
   *  Lifetime members get their NIP-51 URLs auto-archived alongside
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
  private pool?: SimplePool;
  public stats = { processed: 0, enqueued: 0, skipped: 0, failed: 0 };

  constructor(private readonly deps: LifetimeArchiveBackfillDeps) {}

  async start(): Promise<void> {
    this.blockingRedis = this.deps.redis.duplicate();
    this.pool = new SimplePool();
    this.deps.logger.info({ queue: QUEUE }, 'lifetime-archive backfill worker starting');
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.blockingRedis?.disconnect();
    this.blockingRedis = undefined;
    this.pool?.destroy();
    this.pool = undefined;
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
      try {
        await enqueueLifetimeArchive({
          purchases: this.deps.purchases,
          url: bookmark.url,
          userPubkey: pubkey,
          eventId: bookmark.id,
          tier: 'public',
        });
        enqueued += 1;
      } catch (err) {
        failed += 1;
        this.deps.logger.warn(
          { err, pubkey, url: bookmark.url },
          'lifetime-archive enqueue failed',
        );
      }
    }

    // kind:10003 (NIP-51 single bookmark list — Damus/Primal/Amethyst)
    // entries hide direct URLs in `r` tags. Those are bookmarks the
    // user made on other Nostr clients before Deepmarks; archiving
    // them gives lifetime members one library of permanent archives
    // regardless of where the original save lived.
    const remaining = Math.max(0, MAX_ENQUEUE_PER_PUBKEY - enqueued);
    if (remaining > 0 && this.pool) {
      const urls10003 = await this.collectKind10003Urls(pubkey);
      for (const url of urls10003) {
        if (enqueued >= MAX_ENQUEUE_PER_PUBKEY) break;
        if (seenUrls.has(url)) { skipped += 1; continue; }
        seenUrls.add(url);
        try {
          await enqueueLifetimeArchive({
            purchases: this.deps.purchases,
            url,
            userPubkey: pubkey,
            tier: 'public',
          });
          enqueued += 1;
        } catch (err) {
          failed += 1;
          this.deps.logger.warn(
            { err, pubkey, url },
            'lifetime-archive kind:10003 enqueue failed',
          );
        }
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

  /** Pull the user's latest kind:10003 event from our relay and
   *  extract every `r`-tag URL. NIP-51 stores `e` tags too (notes,
   *  not URLs); those require an extra fetch to resolve content URLs
   *  and aren't included in this pass. */
  private async collectKind10003Urls(pubkey: string): Promise<string[]> {
    if (!this.pool) return [];
    try {
      const events = await queryWithTimeout(
        this.pool,
        [this.deps.relayUrl],
        { kinds: [10003], authors: [pubkey], limit: 1 },
        5_000,
      );
      if (events.length === 0) return [];
      // kind:10003 is replaceable — latest by created_at wins.
      const latest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
      const urls = new Set<string>();
      for (const t of latest.tags) {
        if (t[0] !== 'r' || typeof t[1] !== 'string') continue;
        const url = t[1].trim();
        if (!/^https?:\/\//i.test(url)) continue;
        urls.add(url);
      }
      return [...urls];
    } catch (err) {
      this.deps.logger.warn({ err, pubkey }, 'kind:10003 fetch failed');
      return [];
    }
  }
}
