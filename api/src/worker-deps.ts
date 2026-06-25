// Dependency container for the background-worker processes.
//
// The HTTP API builds the full `Deps` container (every store, signer,
// S3 client, Voltage handle, …). The worker fleet needs only a strict
// subset, and — importantly — different worker groups need different
// subsets. A relay-sync worker should never open a Voltage gRPC socket;
// a search-indexer should never hold the bunker-signing client nsec.
//
// `buildWorkerDeps(group)` constructs exactly what a group needs. The
// cheap, side-effect-free stores (Redis-backed stores, the Meili/LLM/
// Qdrant clients — none of which connect at construction time) are built
// unconditionally; the two dependencies that DO have side effects and
// carry secrets — the Voltage connection and the bunker signer sessions —
// are built only for the groups that sign or settle payments.
//
// `workerDepsFromDeps(deps)` adapts an already-built full `Deps` into a
// `WorkerDeps` so the API process can still run the whole fleet in-process
// when RUN_WORKERS=all (dev / single-box), reusing its existing shared
// connections instead of opening a second set.

import { createRedis, PurchaseStore, ZapStore } from './queue.js';
import { createRelayPool } from './nostr.js';
import { LifetimeStore } from './lifetime.js';
import { MeilisearchClient } from './search.js';
import { createEmailSender } from './email.js';
import { makeAlerter, type Alerter } from './alerter.js';
import { buildSigners, loadSignerConfigFromEnv, type SignerSet } from './signer.js';
import { DeepInfraClient, deepInfraConfigFromEnv } from './llm.js';
import { QdrantSemanticStore, qdrantConfigFromEnv, type SemanticVectorStore } from './semantic-vector-store.js';
import { connectToVoltage, validateVoltageConnection } from './voltage.js';
import { createWorkerLogger, type WorkerLogger } from './worker-logger.js';
import type { Redis } from 'ioredis';
import type { Deps } from './route-deps.js';

export const WORKER_GROUPS = ['search-indexer', 'relay-sync', 'enrichment', 'payments', 'all'] as const;
export type WorkerGroup = (typeof WORKER_GROUPS)[number];

export function isWorkerGroup(value: string): value is WorkerGroup {
  return (WORKER_GROUPS as readonly string[]).includes(value);
}

/** Which groups maintain live bunker-signing sessions. */
function needsSigners(group: WorkerGroup): boolean {
  return group === 'relay-sync' || group === 'payments' || group === 'all';
}

/** Which groups talk to the Lightning node. */
function needsLightning(group: WorkerGroup): boolean {
  return group === 'payments' || group === 'all';
}

export interface WorkerDeps {
  logger: WorkerLogger;
  redis: Redis;
  relayPool: ReturnType<typeof createRelayPool>;
  /** Local strfry URL workers subscribe/publish to (INDEXER_RELAY_URL). */
  relayUrl: string;
  /** Canonical public relay used by the fanout worker. */
  canonicalRelayUrl: string;
  meili: MeilisearchClient;
  /** Null for groups that never sign (search-indexer, enrichment). */
  signers: SignerSet | null;
  /** Pubkeys whose kind:9735 receipts the zap listener trusts. Derived
   *  from env so the search-indexer group can build it without opening a
   *  bunker session. */
  trustedReceiptIssuers: ReadonlySet<string>;
  llm: DeepInfraClient;
  semanticStore: SemanticVectorStore | null;
  purchases: PurchaseStore;
  zaps: ZapStore;
  lifetimeStore: LifetimeStore;
  /** Null when Voltage isn't configured / handshake failed. */
  lnd: ReturnType<typeof connectToVoltage>;
  alerter: Alerter;
  LIFETIME_LABEL_RELAYS: string[];
}

function envRelayUrl(): string {
  return process.env.INDEXER_RELAY_URL ?? 'ws://strfry:7777';
}

function envCanonicalRelayUrl(): string {
  return process.env.CANONICAL_RELAY_URL ?? 'wss://relay.deepmarks.org';
}

function envLifetimeLabelRelays(): string[] {
  return (process.env.LIFETIME_LABEL_RELAYS ?? 'ws://strfry:7777,wss://nos.lol,wss://relay.primal.net')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

/** Validate a 64-char hex pubkey from env, or null. */
function envPubkey(key: string): string | null {
  const v = (process.env[key] ?? '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(v) ? v : null;
}

function trustedReceiptIssuersFromEnv(): Set<string> {
  return new Set(
    [envPubkey('BUNKER_BRAND_PUBKEY'), envPubkey('BUNKER_PERSONAL_PUBKEY')]
      .filter((p): p is string => p !== null),
  );
}

function buildLlmClient(logger: WorkerLogger): DeepInfraClient {
  try {
    return new DeepInfraClient(deepInfraConfigFromEnv());
  } catch (err) {
    logger.error({ err }, 'DeepInfra LLM disabled by model policy');
    return new DeepInfraClient(null);
  }
}

function buildAlerter(redis: Redis, logger: WorkerLogger): Alerter {
  return makeAlerter({
    email: createEmailSender(),
    redis,
    to: process.env.ALERT_EMAIL ?? '',
    logger: {
      info: (...a: unknown[]) => logger.info(a[0] as object, a[1] as string),
      error: (...a: unknown[]) => logger.error(a[0] as object, a[1] as string),
    },
  });
}

/**
 * Build a lean dependency set for a worker process running `group`.
 * Opens its own Redis connection and relay pool (this is a separate
 * process from the API); only attaches Voltage / bunker signers for the
 * groups that need them.
 */
export async function buildWorkerDeps(group: WorkerGroup): Promise<WorkerDeps> {
  const logger = createWorkerLogger(`worker:${group}`);
  const redis = createRedis();
  const relayPool = createRelayPool();

  const qdrantConfig = qdrantConfigFromEnv();
  const semanticStore = qdrantConfig ? new QdrantSemanticStore(qdrantConfig) : null;

  let signers: SignerSet | null = null;
  if (needsSigners(group)) {
    signers = buildSigners(loadSignerConfigFromEnv(), {
      info: (obj: object, msg?: string) => logger.info(obj, msg),
      warn: (obj: object, msg?: string) => logger.warn(obj, msg),
      error: (obj: object, msg?: string) => logger.error(obj, msg),
    });
    logger.info({ brand: signers.brand.pubkey.slice(0, 12) + '…' }, 'bunker signers connected');
  }

  let lnd: ReturnType<typeof connectToVoltage> = null;
  if (needsLightning(group)) {
    lnd = connectToVoltage();
    if (lnd) {
      const check = await validateVoltageConnection(lnd);
      if (!check.ok) {
        logger.error({ reason: check.reason, hint: check.hint }, 'voltage handshake failed — disabling Lightning paths');
        lnd = null;
      } else {
        logger.info('voltage connection verified');
      }
    }
  }

  return {
    logger,
    redis,
    relayPool,
    relayUrl: envRelayUrl(),
    canonicalRelayUrl: envCanonicalRelayUrl(),
    meili: new MeilisearchClient(
      process.env.MEILI_URL ?? 'http://meilisearch:7700',
      process.env.MEILI_MASTER_KEY ?? '',
    ),
    signers,
    trustedReceiptIssuers: trustedReceiptIssuersFromEnv(),
    llm: buildLlmClient(logger),
    semanticStore,
    purchases: new PurchaseStore(redis),
    zaps: new ZapStore(redis),
    lifetimeStore: new LifetimeStore(redis),
    lnd,
    alerter: buildAlerter(redis, logger),
    LIFETIME_LABEL_RELAYS: envLifetimeLabelRelays(),
  };
}

/**
 * Adapt the API's already-built full `Deps` into a `WorkerDeps`, reusing
 * its shared connections. Used by `index.ts` when RUN_WORKERS=all so the
 * whole fleet can run in the API process (dev / single-box) exactly as
 * before, without opening a second Redis/relay/signer set.
 */
export function workerDepsFromDeps(deps: Deps): WorkerDeps {
  return {
    logger: deps.app.log,
    redis: deps.redis,
    relayPool: deps.relayPool,
    relayUrl: deps.INDEXER_RELAY_URL_FOR_API,
    canonicalRelayUrl: envCanonicalRelayUrl(),
    meili: deps.meili,
    signers: deps.signers,
    trustedReceiptIssuers: new Set([deps.signers.brand.pubkey, deps.signers.personal.pubkey]),
    llm: deps.llm,
    semanticStore: deps.semanticStore,
    purchases: deps.purchases,
    zaps: deps.zaps,
    lifetimeStore: deps.lifetimeStore,
    lnd: deps.lnd,
    alerter: deps.alerter,
    LIFETIME_LABEL_RELAYS: deps.LIFETIME_LABEL_RELAYS,
  };
}
