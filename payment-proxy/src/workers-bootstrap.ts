// Construct + start the long-running background workers.
//
// These are not request-time deps (routes don't talk to them), so they
// live outside `Deps` and are wired up by `index.ts` after `app.listen`.
// They borrow Redis, Meilisearch, the relay pool, and the signer set
// from the existing `Deps` container so we don't open second connections.

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import { BookmarkIndexer } from './search.js';
import { ZapReceiptListener } from './workers/zap-listener.js';
import { SaveCountTracker } from './workers/save-count-tracker.js';
import { ProfileResolver } from './workers/profile-resolver.js';
import { PinboardSeederWorker, seederIntervalFromEnv } from './workers/pinboard-seeder.js';
import { RelayFanoutWorker } from './workers/relay-fanout.js';
import { OnboardingScannerWorker } from './workers/onboarding-scanner.js';
import { LifetimeArchiveBackfillWorker } from './workers/lifetime-archive-backfill.js';
import { FollowsIngesterWorker } from './workers/follows-ingester.js';
import { queryLifetimeLabels } from './nostr.js';
import { cachePublicBookmarkEvent } from './public-bookmark-cache.js';
import type { Deps } from './route-deps.js';

export interface Workers {
  indexer: BookmarkIndexer;
  zapListener: ZapReceiptListener;
  saveCountTracker: SaveCountTracker;
  profileResolver: ProfileResolver;
  pinboardSeeder: PinboardSeederWorker;
  relayFanout: RelayFanoutWorker;
  onboardingScanner: OnboardingScannerWorker;
  lifetimeArchiveBackfill: LifetimeArchiveBackfillWorker;
  followsIngester: FollowsIngesterWorker;
}

/** SHA-256 of a UTF-8 string, returned as lowercase hex. */
function sha256hex(s: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(s)));
}

function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildWorkers(deps: Deps): Workers {
  const { app, redis, meili, relayPool, signers } = deps;
  const workerLogger = {
    info: app.log.info.bind(app.log),
    error: app.log.error.bind(app.log),
  };
  const relayUrlForWorkers = process.env.INDEXER_RELAY_URL ?? 'ws://strfry:7777';

  const indexer = new BookmarkIndexer(
    meili,
    relayUrlForWorkers,
    { info: app.log.info.bind(app.log), error: app.log.error.bind(app.log) },
    async (pubkey) => (await redis.get(`dm:profile-name:${pubkey}`)) ?? undefined,
    async (url) => (await redis.scard(`dm:url-savers:${sha256hex(url)}`)) ?? 0,
    async (event) => cachePublicBookmarkEvent(redis, event),
  );

  const zapListener = new ZapReceiptListener({
    redis,
    meili,
    relayUrl: relayUrlForWorkers,
    // Only count zap receipts authored by signers we control. NIP-57
    // lets any LNURL provider sign receipts; without this filter,
    // anyone can publish a kind:9735 with a forged amount and inflate
    // search ranking. Cross-provider zap aggregation can be added
    // later via an explicit allowlist of trusted external providers.
    trustedReceiptIssuers: new Set([signers.brand.pubkey, signers.personal.pubkey]),
    logger: workerLogger,
  });

  const saveCountTracker = new SaveCountTracker({
    redis,
    meili,
    relayUrl: relayUrlForWorkers,
    logger: workerLogger,
  });

  const profileResolver = new ProfileResolver({
    redis,
    relayUrl: relayUrlForWorkers,
    logger: workerLogger,
  });

  const pinboardSeeder = new PinboardSeederWorker(
    {
      pool: relayPool,
      logger: {
        info: (msg) => app.log.info(msg),
        warn: (msg) => app.log.warn(msg),
        error: (msg) => app.log.error(msg),
      },
      // Production maps the legacy "personal" bunker role to the
      // public brand/social npub199z... profile. The daily Pinboard
      // bookmark and its kind:1 cross-post should come from that public
      // profile, not from the admin/operational npub10... signer.
      signer: signers.personal,
      claimDailyRun: async () => {
        const key = `dm:pinboard-daily:${utcDateKey()}`;
        const claimed = await redis.set(key, '1', 'EX', 36 * 60 * 60, 'NX');
        return {
          ok: claimed === 'OK',
          release: async () => { await redis.del(key); },
        };
      },
    },
    seederIntervalFromEnv(),
  );

  const relayFanout = new RelayFanoutWorker({
    redis,
    relayUrl: relayUrlForWorkers,
    canonicalRelayUrl: process.env.CANONICAL_RELAY_URL ?? 'wss://relay.deepmarks.org',
    logger: {
      info: app.log.info.bind(app.log),
      warn: app.log.warn.bind(app.log),
      error: app.log.error.bind(app.log),
    },
  });

  const onboardingScanner = new OnboardingScannerWorker({
    redis,
    localRelayUrl: relayUrlForWorkers,
    logger: {
      info: app.log.info.bind(app.log),
      warn: app.log.warn.bind(app.log),
      error: app.log.error.bind(app.log),
    },
  });

  const lifetimeArchiveBackfill = new LifetimeArchiveBackfillWorker({
    redis,
    purchases: deps.purchases,
    relayUrl: relayUrlForWorkers,
    logger: {
      info: app.log.info.bind(app.log),
      warn: app.log.warn.bind(app.log),
      error: app.log.error.bind(app.log),
    },
  });

  const followsIngester = new FollowsIngesterWorker({
    redis,
    relayUrl: relayUrlForWorkers,
    logger: {
      info: app.log.info.bind(app.log),
      warn: app.log.warn.bind(app.log),
      error: app.log.error.bind(app.log),
    },
  });

  return {
    indexer, zapListener, saveCountTracker, profileResolver, pinboardSeeder,
    relayFanout, onboardingScanner, lifetimeArchiveBackfill, followsIngester,
  };
}

/** Start workers after `app.listen`. Indexer + zap/save trackers gated
 *  on Meilisearch being configured (dev mode without search skips them). */
export function startWorkers(deps: Deps, workers: Workers): void {
  const { app } = deps;
  const meiliEnabled = !!process.env.MEILI_URL && !!process.env.MEILI_MASTER_KEY;
  if (meiliEnabled) {
    workers.indexer.start().catch((err) => {
      app.log.error({ err }, 'indexer failed to start — public search may be stale');
    });
    workers.zapListener.start().catch((err) => {
      app.log.error({ err }, 'zap listener failed to start — zap_total may be stale');
    });
    workers.saveCountTracker.start().catch((err) => {
      app.log.error({ err }, 'save-count tracker failed to start');
    });
  } else {
    app.log.warn('MEILI_URL/MEILI_MASTER_KEY not set — skipping search indexer + zap/save-count trackers (dev mode)');
  }
  workers.profileResolver.start().catch((err) => {
    app.log.error({ err }, 'profile resolver failed to start');
  });
  workers.pinboardSeeder.start().catch((err) => {
    app.log.error({ err }, 'pinboard seeder failed to start');
  });
  workers.relayFanout.start().catch((err) => {
    app.log.error({ err }, 'relay fanout worker failed to start');
  });
  workers.onboardingScanner.start().catch((err) => {
    app.log.error({ err }, 'onboarding scanner failed to start');
  });
  workers.lifetimeArchiveBackfill.start().catch((err) => {
    app.log.error({ err }, 'lifetime-archive backfill worker failed to start');
  });
  workers.followsIngester.start().catch((err) => {
    app.log.error({ err }, 'follows-ingester worker failed to start');
  });
}

/** Durability layer #2 recovery: on boot, pull our own lifetime-label
 *  events off relays and stamp any pubkey that Redis doesn't already
 *  know about. BTCPay is the primary recovery source (see the admin
 *  reconcile endpoint); this covers the edge case where BTCPay itself
 *  is unreachable but the relay ledger survives. */
export function recoverLifetimeLabels(deps: Deps): void {
  const { app, signers, LIFETIME_LABEL_RELAYS, relayPool, lifetimeStore } = deps;
  void (async () => {
    try {
      const labels = await queryLifetimeLabels(signers.brand.pubkey, LIFETIME_LABEL_RELAYS, relayPool);
      let stamped = 0;
      for (const { memberPubkey, paidAt } of labels) {
        if (!(await lifetimeStore.isPaid(memberPubkey))) {
          await lifetimeStore.markPaid(memberPubkey, paidAt);
          stamped++;
        }
      }
      app.log.info({ scanned: labels.length, stamped }, 'lifetime-label relay sync complete');
    } catch (err) {
      app.log.warn({ err }, 'lifetime-label relay sync failed — continuing without it');
    }
  })();
}
