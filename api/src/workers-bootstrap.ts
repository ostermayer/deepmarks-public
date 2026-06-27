// Construct + start the long-running background workers, grouped by
// task so each group can run in its own process.
//
// Groups (see WorkerGroup in worker-deps.ts):
//   search-indexer  relay→Meilisearch writers (bookmark index, save-count,
//                   zap-total). Meili-gated.
//   relay-sync      the network-heavy outbox: relay fanout, onboarding
//                   scanner, follows ingester, profile resolver, plus the
//                   daily Pinboard seeder.
//   enrichment      the LLM enrichment queue consumer.
//   payments        the Lightning invoice listener, the lifetime-archive
//                   backfill, and the boot-time lifetime-label recovery.
//   all             every group in one process (the legacy single-process
//                   shape; used by the API when RUN_WORKERS=all).
//
// Workers don't share mutable in-process state with the HTTP routes —
// they communicate only through Redis / the relay / Meilisearch — so a
// group runs identically whether it's hosted by the API process or its
// own container. Live stats are surfaced for the dashboard heartbeat
// (see worker-stats.ts) rather than read out of memory.

import { BookmarkIndexer } from './search.js';
import { ZapReceiptListener } from './workers/zap-listener.js';
import { SaveCountTracker } from './workers/save-count-tracker.js';
import { ProfileResolver } from './workers/profile-resolver.js';
import { PinboardSeederWorker, seederIntervalFromEnv } from './workers/pinboard-seeder.js';
import { RelayFanoutWorker } from './workers/relay-fanout.js';
import { OnboardingScannerWorker } from './workers/onboarding-scanner.js';
import { LifetimeArchiveBackfillWorker } from './workers/lifetime-archive-backfill.js';
import { FollowsIngesterWorker } from './workers/follows-ingester.js';
import { LlmEnrichmentWorker, queueBookmarkEnrichment } from './llm-enrichment.js';
import { attachInvoiceHandler, type InvoiceSubHandle } from './invoice-handler.js';
import { queryLifetimeLabels } from './nostr.js';
import { cachePublicBookmarkEvent } from './public-bookmark-cache.js';
import { urlIndexHash } from './url-index.js';
import type { SignerSet } from './signer.js';
import type { WorkerLogger } from './worker-logger.js';
import type { StatsSource } from './worker-stats.js';
import type { WorkerDeps, WorkerGroup } from './worker-deps.js';

/** A single startable/stoppable unit (one worker, the invoice listener,
 *  or a boot job), optionally exposing live stats for the dashboard. */
interface Unit {
  start: () => void;
  stop: () => Promise<void> | void;
  stats?: StatsSource;
}

export interface WorkerGroupHandle {
  /** Start every unit in the group (non-blocking; failures are logged). */
  start: () => void;
  /** Stop every unit; resolves once all have settled. */
  stop: () => Promise<void>;
  /** Workers exposing live stats for the Redis heartbeat. */
  statsSources: StatsSource[];
}

function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Wrap a worker's start/stop into a Unit. start() is fire-and-forget
 *  with a logged catch, matching the original startWorkers() semantics
 *  (a slow/failed start never blocks its siblings). */
function makeUnit(
  logger: WorkerLogger,
  label: string,
  worker: { start: () => Promise<void> | void; stop: () => Promise<void> | void },
  stats?: StatsSource,
): Unit {
  return {
    start: () => {
      void Promise.resolve(worker.start()).catch((err) =>
        logger.error({ err, worker: label }, 'worker failed to start'),
      );
    },
    stop: () => Promise.resolve(worker.stop()),
    stats,
  };
}

function requireSigners(wd: WorkerDeps): SignerSet {
  if (!wd.signers) {
    // buildWorkerDeps only omits signers for groups that never sign, so
    // reaching here is a wiring bug, not a config error.
    throw new Error('worker group requires bunker signers but none were built');
  }
  return wd.signers;
}

// ─── search-indexer ──────────────────────────────────────────────────

function buildSearchIndexerUnits(wd: WorkerDeps): Unit[] {
  const meiliEnabled = !!process.env.MEILI_URL && !!process.env.MEILI_MASTER_KEY;
  if (!meiliEnabled) {
    wd.logger.warn('MEILI_URL/MEILI_MASTER_KEY not set — skipping search-indexer workers (dev mode)');
    return [];
  }
  const L = wd.logger;
  const ie = { info: L.info.bind(L), error: L.error.bind(L) };

  const queueLlmBookmarkEnrichment = wd.llm.enabled
    ? async (doc: Parameters<typeof queueBookmarkEnrichment>[1]) => { await queueBookmarkEnrichment(wd.redis, doc); }
    : undefined;

  const indexer = new BookmarkIndexer(
    wd.meili,
    wd.relayUrl,
    ie,
    async (pubkey) => (await wd.redis.get(`dm:profile-name:${pubkey}`)) ?? undefined,
    async (url) => (await wd.redis.scard(`dm:url-savers:${urlIndexHash(url)}`)) ?? 0,
    async (event) => cachePublicBookmarkEvent(wd.redis, event),
    queueLlmBookmarkEnrichment,
  );

  const zapListener = new ZapReceiptListener({
    redis: wd.redis,
    meili: wd.meili,
    relayUrl: wd.relayUrl,
    // Only count zap receipts from signers we control (forged kind:9735
    // amounts would otherwise game search ranking). Derived from env
    // pubkeys so this group needs no bunker session.
    trustedReceiptIssuers: wd.trustedReceiptIssuers,
    logger: ie,
  });

  const saveCountTracker = new SaveCountTracker({
    redis: wd.redis,
    meili: wd.meili,
    relayUrl: wd.relayUrl,
    logger: ie,
  });

  return [
    makeUnit(L, 'indexer', indexer),
    makeUnit(L, 'zapListener', zapListener),
    makeUnit(L, 'saveCountTracker', saveCountTracker),
  ];
}

// ─── relay-sync (outbox) ─────────────────────────────────────────────

function buildRelaySyncUnits(wd: WorkerDeps): Unit[] {
  const L = wd.logger;
  const ie = { info: L.info.bind(L), error: L.error.bind(L) };
  const iwe = { info: L.info.bind(L), warn: L.warn.bind(L), error: L.error.bind(L) };
  const signers = requireSigners(wd);

  const profileResolver = new ProfileResolver({
    redis: wd.redis,
    relayUrl: wd.relayUrl,
    logger: ie,
  });

  const pinboardSeeder = new PinboardSeederWorker(
    {
      pool: wd.relayPool,
      logger: {
        info: (msg) => L.info(msg),
        warn: (msg) => L.warn(msg),
        error: (msg) => L.error(msg),
      },
      // The daily Pinboard bookmark + kind:1 cross-post come from the
      // public brand/social profile (legacy "personal" bunker role).
      signer: signers.personal,
      claimDailyRun: async () => {
        const key = `dm:pinboard-daily:${utcDateKey()}`;
        const claimed = await wd.redis.set(key, '1', 'EX', 36 * 60 * 60, 'NX');
        return {
          ok: claimed === 'OK',
          release: async () => { await wd.redis.del(key); },
        };
      },
    },
    seederIntervalFromEnv(),
  );

  const relayFanout = new RelayFanoutWorker({
    redis: wd.redis,
    relayUrl: wd.relayUrl,
    canonicalRelayUrl: wd.canonicalRelayUrl,
    alerter: wd.alerter,
    logger: iwe,
  });

  const onboardingScanner = new OnboardingScannerWorker({
    redis: wd.redis,
    localRelayUrl: wd.relayUrl,
    logger: iwe,
  });

  const followsIngester = new FollowsIngesterWorker({
    redis: wd.redis,
    relayUrl: wd.relayUrl,
    logger: iwe,
  });

  return [
    makeUnit(L, 'profileResolver', profileResolver),
    makeUnit(L, 'pinboardSeeder', pinboardSeeder),
    makeUnit(L, 'relayFanout', relayFanout, { name: 'relayFanout', getStats: () => relayFanout.stats }),
    makeUnit(L, 'onboardingScanner', onboardingScanner, { name: 'onboardingScanner', getStats: () => onboardingScanner.stats }),
    makeUnit(L, 'followsIngester', followsIngester, { name: 'followsIngester', getStats: () => followsIngester.stats }),
  ];
}

// ─── enrichment ──────────────────────────────────────────────────────

function buildEnrichmentUnits(wd: WorkerDeps): Unit[] {
  const L = wd.logger;
  const iwe = { info: L.info.bind(L), warn: L.warn.bind(L), error: L.error.bind(L) };

  const llmEnrichment = new LlmEnrichmentWorker({
    redis: wd.redis,
    meili: wd.meili,
    llm: wd.llm,
    semanticStore: wd.semanticStore,
    logger: iwe,
  });

  return [
    makeUnit(L, 'llmEnrichment', llmEnrichment, { name: 'llmEnrichment', getStats: () => llmEnrichment.stats }),
  ];
}

// ─── payments ────────────────────────────────────────────────────────

function buildPaymentsUnits(wd: WorkerDeps): Unit[] {
  const L = wd.logger;
  const iwe = { info: L.info.bind(L), warn: L.warn.bind(L), error: L.error.bind(L) };
  const signers = requireSigners(wd);

  const lifetimeArchiveBackfill = new LifetimeArchiveBackfillWorker({
    redis: wd.redis,
    purchases: wd.purchases,
    relayUrl: wd.relayUrl,
    logger: iwe,
  });

  // Lightning invoice listener — settles zaps (publishes signed kind:9735
  // receipts) and legacy metered archive invoices. Attach on start, tear
  // down its listeners on stop.
  let invoiceSub: InvoiceSubHandle | null = null;
  const invoiceUnit: Unit = {
    start: () => {
      invoiceSub = attachInvoiceHandler({
        logger: wd.logger,
        redis: wd.redis,
        lnd: wd.lnd,
        zaps: wd.zaps,
        purchases: wd.purchases,
        signers,
        relayPool: wd.relayPool,
        alerter: wd.alerter,
      });
      if (!invoiceSub) {
        wd.logger.warn('Voltage not configured — invoice listener disabled (zaps + metered archives will not settle)');
      }
    },
    stop: () => { invoiceSub?.removeAllListeners(); },
  };

  // Boot job: rehydrate lifetime members from relay labels (durability
  // layer #2). Fire-and-forget; see recoverLifetimeLabels.
  const recoveryUnit: Unit = {
    start: () => recoverLifetimeLabels(wd),
    stop: () => {},
  };

  return [
    invoiceUnit,
    makeUnit(L, 'lifetimeArchiveBackfill', lifetimeArchiveBackfill, { name: 'lifetimeArchiveBackfill', getStats: () => lifetimeArchiveBackfill.stats }),
    recoveryUnit,
  ];
}

/**
 * Build the worker group for `group` from an already-built `WorkerDeps`.
 * Returns a handle that starts/stops every unit and exposes the group's
 * stats sources.
 */
export function buildWorkerGroup(wd: WorkerDeps, group: WorkerGroup): WorkerGroupHandle {
  const units: Unit[] = [];
  if (group === 'search-indexer' || group === 'all') units.push(...buildSearchIndexerUnits(wd));
  if (group === 'relay-sync' || group === 'all') units.push(...buildRelaySyncUnits(wd));
  if (group === 'enrichment' || group === 'all') units.push(...buildEnrichmentUnits(wd));
  if (group === 'payments' || group === 'all') units.push(...buildPaymentsUnits(wd));

  return {
    statsSources: units.map((u) => u.stats).filter((s): s is StatsSource => s !== undefined),
    start: () => {
      for (const u of units) u.start();
    },
    stop: async () => {
      await Promise.allSettled(units.map((u) => Promise.resolve(u.stop())));
    },
  };
}

/** Durability layer #2 recovery: on boot, pull our own lifetime-label
 *  events off relays and stamp any pubkey that Redis doesn't already
 *  know about. BTCPay is the primary recovery source (admin reconcile
 *  endpoint); this covers the edge case where BTCPay is unreachable but
 *  the relay ledger survives. Read-only — needs the brand pubkey, not a
 *  signing session. */
function recoverLifetimeLabels(wd: WorkerDeps): void {
  const { logger, signers, LIFETIME_LABEL_RELAYS, relayPool, lifetimeStore } = wd;
  if (!signers) return;
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
      logger.info({ scanned: labels.length, stamped }, 'lifetime-label relay sync complete');
    } catch (err) {
      logger.warn({ err }, 'lifetime-label relay sync failed — continuing without it');
    }
  })();
}
