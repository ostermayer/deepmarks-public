import type { FastifyBaseLogger } from 'fastify';
import type { PurchaseRecord } from './types.js';
import type { PurchaseStore } from './queue.js';
import type { Alerter } from './alerter.js';

/** Result of the shared markPaid → enqueue → rollback core. */
export type MarkPaidAndEnqueueResult =
  | { status: 'not-found' }
  | { status: 'enqueued'; record: PurchaseRecord }
  | { status: 'enqueue-failed'; record: PurchaseRecord; error: unknown };

/**
 * The one markPaid → enqueueArchiveJob → rollback-on-failure sequence.
 * This exact dance was hand-rolled three times (settlement webhooks,
 * lifetime direct enqueue, media add-on route) with drifting rollback
 * handling (2026-08-23 review, simplification backlog); every settle
 * path now goes through here.
 *
 * On enqueue failure the record is rolled back to pending so the caller
 * (or the payment processor's retry) can settle again — markPaid's
 * SET-NX gate would otherwise swallow every future attempt. A rollback
 * failure is swallowed after reporting through `onRollbackFailure`
 * (the record is then stuck 'paid' with no job — callers with an
 * alerter escalate to critical). markPaid's own errors propagate —
 * nothing was claimed yet, so there is nothing to roll back.
 *
 * Never throws past markPaid: the enqueue outcome comes back as a
 * discriminated result so HTTP callers can rethrow while webhook
 * callers absorb.
 */
export async function markPaidAndEnqueue(opts: {
  purchases: PurchaseStore;
  paymentHash: string;
  onRollbackFailure?: (record: PurchaseRecord, rollbackErr: unknown) => void;
}): Promise<MarkPaidAndEnqueueResult> {
  const { purchases, paymentHash } = opts;
  const record = await purchases.markPaid(paymentHash);
  if (!record) return { status: 'not-found' };
  try {
    await purchases.enqueueArchiveJob(record);
    return { status: 'enqueued', record };
  } catch (error) {
    await purchases.rollbackToPending(paymentHash).catch((rollbackErr) => {
      opts.onRollbackFailure?.(record, rollbackErr);
    });
    return { status: 'enqueue-failed', record, error };
  }
}

export interface SettleArchivePurchaseResult {
  handled: boolean;
  record?: PurchaseRecord;
}

/**
 * Settlement-context wrapper: the core above plus operator visibility.
 * Webhook / invoice-listener callers must not crash on an enqueue
 * failure (the processor retries; the record is back in pending), so
 * the failure is absorbed into `handled: true` and reported by alert
 * instead. HTTP routes use markPaidAndEnqueue directly and rethrow so
 * the client sees the failure.
 */
export async function settleArchivePurchase(opts: {
  purchases: PurchaseStore;
  paymentHash: string;
  log: FastifyBaseLogger;
  alerter: Alerter;
  source: 'voltage' | 'btcpay';
}): Promise<SettleArchivePurchaseResult> {
  const { purchases, paymentHash, log, alerter, source } = opts;
  const result = await markPaidAndEnqueue({
    purchases,
    paymentHash,
    onRollbackFailure: (record, rollbackErr) => {
      log.error(
        { err: rollbackErr, paymentHash, user: record.userPubkey, source },
        'CRITICAL: rollback also failed — record stays paid; manual reconcile required',
      );
      void alerter.alert({
        severity: 'critical',
        key: 'archive-rollback-failed',
        subject: 'CRITICAL: archive rollback failed — manual reconcile required',
        body: `User ${record.userPubkey} has an archive purchase at ${paymentHash}. Both the queue rpush AND the rollback to pending failed. Their record is stuck in paid state with no archive job. Reconcile manually from the payment processor dashboard and Redis.\n\nRollback error: ${(rollbackErr as Error).message ?? rollbackErr}`,
      });
    },
  });
  if (result.status === 'not-found') return { handled: false };

  const rec = result.record;
  if (result.status === 'enqueued') {
    log.info(
      { paymentHash, url: rec.url, user: rec.userPubkey, source, kind: rec.kind ?? 'webpage' },
      'archive job enqueued',
    );
    return { handled: true, record: rec };
  }

  const enqueueErr = result.error;
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
  return { handled: true, record: rec };
}
