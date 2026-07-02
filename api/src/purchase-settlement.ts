import type { FastifyBaseLogger } from 'fastify';
import type { PurchaseRecord } from './types.js';
import type { PurchaseStore } from './queue.js';
import type { Alerter } from './alerter.js';

export interface SettleArchivePurchaseResult {
  handled: boolean;
  record?: PurchaseRecord;
}

export async function settleArchivePurchase(opts: {
  purchases: PurchaseStore;
  paymentHash: string;
  log: FastifyBaseLogger;
  alerter: Alerter;
  source: 'voltage' | 'btcpay';
}): Promise<SettleArchivePurchaseResult> {
  const { purchases, paymentHash, log, alerter, source } = opts;
  const rec = await purchases.markPaid(paymentHash);
  if (!rec) return { handled: false };

  try {
    await purchases.enqueueArchiveJob(rec);
    log.info(
      { paymentHash, url: rec.url, user: rec.userPubkey, source, kind: rec.kind ?? 'webpage' },
      'archive job enqueued',
    );
    return { handled: true, record: rec };
  } catch (enqueueErr) {
    log.error(
      { err: enqueueErr, paymentHash, user: rec.userPubkey, source },
      'archive enqueue failed AFTER markPaid — rolling back to pending',
    );
    void alerter.alert({
      severity: 'warning',
      key: 'archive-enqueue-failed',
      subject: `archive enqueue failed after markPaid (${source} ${String(paymentHash).slice(0, 12)}...)`,
      body: `User ${rec.userPubkey} paid for an archive but the queue rpush failed. Auto-rolled back to pending so the settlement path can retry. If this fires repeatedly, check Redis health.\n\nError: ${(enqueueErr as Error).message ?? enqueueErr}`,
    });
    await purchases.rollbackToPending(paymentHash).catch((rollbackErr) => {
      log.error(
        { err: rollbackErr, paymentHash, user: rec.userPubkey, source },
        'CRITICAL: rollback also failed — record stays paid; manual reconcile required',
      );
      void alerter.alert({
        severity: 'critical',
        key: 'archive-rollback-failed',
        subject: 'CRITICAL: archive rollback failed — manual reconcile required',
        body: `User ${rec.userPubkey} has an archive purchase at ${paymentHash}. Both the queue rpush AND the rollback to pending failed. Their record is stuck in paid state with no archive job. Reconcile manually from the payment processor dashboard and Redis.\n\nRollback error: ${(rollbackErr as Error).message ?? rollbackErr}`,
      });
    });
    return { handled: true, record: rec };
  }
}
