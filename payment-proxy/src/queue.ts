import { Redis } from 'ioredis';
import type { ArchiveJob, PendingZap, PurchaseRecord } from './types.js';

const PURCHASE_PREFIX = 'dm:purchase:';
const ZAP_PREFIX = 'dm:zap:';
// Must match archive-worker/src/queue.ts:KEYS.queue. The worker BLMOVEs
// items off this exact key into its per-worker processing list. A mismatch
// here means jobs pile up and never get processed — which is exactly what
// happened before this commit.
const ARCHIVE_QUEUE = 'dm:archive:queue';
const TTL_SECONDS = 60 * 60 * 2;      // 2h for purchases
const ZAP_TTL_SECONDS = 60 * 30;      // 30m for zaps (invoice expires in 10m)

// ─── Archive purchases ────────────────────────────────────────────────

export class PurchaseStore {
  constructor(private readonly redis: Redis) {}

  async create(record: PurchaseRecord): Promise<void> {
    await this.redis.set(
      PURCHASE_PREFIX + record.paymentHash,
      JSON.stringify(record),
      'EX',
      TTL_SECONDS,
    );
  }

  async get(paymentHash: string): Promise<PurchaseRecord | null> {
    const raw = await this.redis.get(PURCHASE_PREFIX + paymentHash);
    if (!raw) return null;
    try { return JSON.parse(raw) as PurchaseRecord; }
    catch { return null; /* corrupt blob — treat as missing rather than crashing the caller */ }
  }

  /**
   * Transition pending → paid. Returns the record only if THIS call did
   * the transition. Returns null if the record is missing OR if another
   * caller already claimed it. The caller uses null as the signal not
   * to enqueue an archive job (preventing double-archive on duplicate
   * LND callback delivery).
   */
  async markPaid(paymentHash: string): Promise<PurchaseRecord | null> {
    // SET NX on a sibling "claim" key is the atomic gate. Only one
    // caller can flip it from absent to '1'; everyone else returns null.
    // The key shares the record's TTL so it's reaped together.
    const claimedKey = PURCHASE_PREFIX + paymentHash + ':claimed';
    const claim = await this.redis.set(claimedKey, '1', 'EX', TTL_SECONDS, 'NX');
    if (claim !== 'OK') return null;

    const rec = await this.get(paymentHash);
    if (!rec) {
      // Phantom claim — no underlying record (e.g. expired between create
      // and settlement). Drop the marker so a future create can claim.
      await this.redis.del(claimedKey).catch(() => {});
      return null;
    }
    if (rec.status !== 'pending') {
      // Record exists but already advanced past pending (manual requeue,
      // etc.). The claim is harmless; let it expire with its TTL.
      return null;
    }

    rec.status = 'paid';
    rec.paidAt = nowSeconds();
    await this.redis.set(
      PURCHASE_PREFIX + paymentHash,
      JSON.stringify(rec),
      'EX',
      TTL_SECONDS,
    );
    return rec;
  }

  async enqueueArchiveJob(record: PurchaseRecord): Promise<void> {
    // Shape MUST match archive-worker/src/queue.ts:ArchiveJob. Drift
    // here breaks the worker silently — undefined fields propagate
    // into done records (we saw `dm:archive:done:undefined` in prod).
    const job: ArchiveJob = {
      jobId: record.paymentHash,
      paymentHash: record.paymentHash,
      ownerPubkey: record.userPubkey,
      url: record.url,
      eventId: record.eventId,
      tier: record.tier ?? 'public',
      archiveKey: record.archiveKey ?? null,
      attempts: 0,
      enqueuedAt: nowSeconds(),
    };
    await this.redis.rpush(ARCHIVE_QUEUE, JSON.stringify(job));

    // Clear archiveKey from the persisted purchase record now that the
    // worker has its copy on the queue. The key is sensitive — it
    // unlocks the encrypted snapshot — and there's no reason to keep
    // it in two places. The worker zeros its in-memory copy after
    // encryption (see archive-worker/src/crypto.ts:zeroize); this
    // keeps Redis from hanging on to it for the rest of TTL_SECONDS.
    record.status = 'enqueued';
    record.archiveKey = undefined;
    await this.redis.set(
      PURCHASE_PREFIX + record.paymentHash,
      JSON.stringify(record),
      'EX',
      TTL_SECONDS,
    );
  }

  /** Roll a paid record back to pending state and clear the claim
   *  marker. Used when enqueueArchiveJob fails — without this the
   *  user has paid but their archive will never run, since markPaid's
   *  SET-NX gate blocks re-entry on the next invoice-settlement
   *  delivery. Best-effort: failure here means the record stays paid
   *  and an operator has to manually reconcile. */
  async rollbackToPending(paymentHash: string): Promise<void> {
    const claimedKey = PURCHASE_PREFIX + paymentHash + ':claimed';
    const rec = await this.get(paymentHash);
    if (rec) {
      rec.status = 'pending';
      rec.paidAt = undefined;
      await this.redis.set(
        PURCHASE_PREFIX + paymentHash,
        JSON.stringify(rec),
        'EX',
        TTL_SECONDS,
      );
    }
    await this.redis.del(claimedKey).catch(() => {});
  }
}

// ─── Pending zaps ─────────────────────────────────────────────────────

export class ZapStore {
  constructor(private readonly redis: Redis) {}

  async create(zap: PendingZap): Promise<void> {
    await this.redis.set(
      ZAP_PREFIX + zap.paymentHash,
      JSON.stringify(zap),
      'EX',
      ZAP_TTL_SECONDS,
    );
  }

  async get(paymentHash: string): Promise<PendingZap | null> {
    const raw = await this.redis.get(ZAP_PREFIX + paymentHash);
    if (!raw) return null;
    try { return JSON.parse(raw) as PendingZap; }
    catch { return null; }
  }

  /** Atomic GET+DEL so two near-simultaneous LND callbacks for the
   *  same paid invoice can't both publish a kind:9735 receipt. Requires
   *  Redis 6.2+ (deepmarks ships redis:7-alpine). */
  async consume(paymentHash: string): Promise<PendingZap | null> {
    const raw = await this.redis.getdel(ZAP_PREFIX + paymentHash);
    if (!raw) return null;
    try { return JSON.parse(raw) as PendingZap; }
    catch { return null; }
  }
}

// ─── Shared Redis client ──────────────────────────────────────────────

export function createRedis(): Redis {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  redis.on('error', (err) => {
    console.error('[redis] error', err.message);
  });
  return redis;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
