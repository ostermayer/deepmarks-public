import { describe, expect, it } from 'vitest';

import { markPaidAndEnqueue, settleArchivePurchase } from '@src/purchase-settlement.js';
import type { PurchaseStore } from '@src/queue.js';
import type { PurchaseRecord } from '@src/types.js';
import type { Alerter, AlertOpts } from '@src/alerter.js';
import type { FastifyBaseLogger } from 'fastify';

// Pins the settlement core's external contract (2026-08-23 simplification:
// the markPaid → enqueue → rollback sequence was hand-rolled three times;
// these tests were written against the pre-refactor behavior and must stay
// green across the extraction).

class FakePurchaseStore {
  record: PurchaseRecord | null = null;
  queued: PurchaseRecord[] = [];
  rollbacks: string[] = [];
  failEnqueue = false;
  failRollback = false;

  seed(paymentHash: string): void {
    this.record = {
      url: 'https://example.com/post',
      userPubkey: 'a'.repeat(64),
      paymentHash,
      invoice: '',
      amountSats: 0,
      status: 'pending',
      createdAt: 1_700_000_000,
    };
  }

  async markPaid(paymentHash: string): Promise<PurchaseRecord | null> {
    if (!this.record || this.record.paymentHash !== paymentHash) return null;
    this.record.status = 'paid';
    return this.record;
  }

  async enqueueArchiveJob(record: PurchaseRecord): Promise<void> {
    if (this.failEnqueue) throw new Error('rpush failed');
    this.queued.push(record);
  }

  async rollbackToPending(paymentHash: string): Promise<void> {
    if (this.failRollback) throw new Error('rollback redis down');
    this.rollbacks.push(paymentHash);
    if (this.record?.paymentHash === paymentHash) this.record.status = 'pending';
  }
}

class FakeAlerter {
  alerts: AlertOpts[] = [];
  async alert(opts: AlertOpts): Promise<void> {
    this.alerts.push(opts);
  }
}

function fakeLog(): FastifyBaseLogger & { infos: string[]; errors: string[] } {
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    errors,
    info: (_obj: unknown, msg?: string) => { infos.push(msg ?? String(_obj)); },
    error: (_obj: unknown, msg?: string) => { errors.push(msg ?? String(_obj)); },
    warn: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    silent: () => undefined,
    child: () => fakeLog(),
    level: 'info',
  } as unknown as FastifyBaseLogger & { infos: string[]; errors: string[] };
}

const HASH = 'f'.repeat(64);

function run(purchases: FakePurchaseStore, alerter: FakeAlerter, log = fakeLog()) {
  return settleArchivePurchase({
    purchases: purchases as unknown as PurchaseStore,
    paymentHash: HASH,
    log,
    alerter: alerter as unknown as Alerter,
    source: 'voltage',
  });
}

describe('markPaidAndEnqueue', () => {
  it('returns not-found when markPaid has nothing to claim', async () => {
    const purchases = new FakePurchaseStore();
    const result = await markPaidAndEnqueue({
      purchases: purchases as unknown as PurchaseStore,
      paymentHash: HASH,
    });
    expect(result).toEqual({ status: 'not-found' });
  });

  it('returns the enqueued record on success', async () => {
    const purchases = new FakePurchaseStore();
    purchases.seed(HASH);
    const result = await markPaidAndEnqueue({
      purchases: purchases as unknown as PurchaseStore,
      paymentHash: HASH,
    });
    expect(result.status).toBe('enqueued');
    expect(purchases.queued).toHaveLength(1);
  });

  it('rolls back and returns enqueue-failed with the original error — never throws', async () => {
    const purchases = new FakePurchaseStore();
    purchases.seed(HASH);
    purchases.failEnqueue = true;
    const result = await markPaidAndEnqueue({
      purchases: purchases as unknown as PurchaseStore,
      paymentHash: HASH,
    });
    expect(result.status).toBe('enqueue-failed');
    expect((result as { error: Error }).error.message).toBe('rpush failed');
    expect(purchases.rollbacks).toEqual([HASH]);
    expect(purchases.record?.status).toBe('pending');
  });

  it('swallows a rollback failure after reporting it through onRollbackFailure', async () => {
    const purchases = new FakePurchaseStore();
    purchases.seed(HASH);
    purchases.failEnqueue = true;
    purchases.failRollback = true;
    const reported: unknown[] = [];
    const result = await markPaidAndEnqueue({
      purchases: purchases as unknown as PurchaseStore,
      paymentHash: HASH,
      onRollbackFailure: (_record, rollbackErr) => { reported.push(rollbackErr); },
    });
    expect(result.status).toBe('enqueue-failed');
    expect((reported[0] as Error).message).toBe('rollback redis down');
    expect(purchases.record?.status).toBe('paid');
  });
});

describe('settleArchivePurchase', () => {
  it('returns handled:false when there is no pending record to settle', async () => {
    const purchases = new FakePurchaseStore();
    const alerter = new FakeAlerter();
    const result = await run(purchases, alerter);
    expect(result).toEqual({ handled: false });
    expect(purchases.queued).toHaveLength(0);
    expect(alerter.alerts).toHaveLength(0);
  });

  it('enqueues the job and returns the record on success', async () => {
    const purchases = new FakePurchaseStore();
    purchases.seed(HASH);
    const alerter = new FakeAlerter();
    const log = fakeLog();
    const result = await run(purchases, alerter, log);
    expect(result.handled).toBe(true);
    expect(result.record?.paymentHash).toBe(HASH);
    expect(purchases.queued).toHaveLength(1);
    expect(purchases.rollbacks).toHaveLength(0);
    expect(alerter.alerts).toHaveLength(0);
    expect(log.infos).toContain('archive job enqueued');
  });

  it('rolls back to pending and alerts (warning) when the enqueue fails — without throwing', async () => {
    const purchases = new FakePurchaseStore();
    purchases.seed(HASH);
    purchases.failEnqueue = true;
    const alerter = new FakeAlerter();
    const log = fakeLog();
    const result = await run(purchases, alerter, log);
    // The settlement layer absorbs the failure (webhook/listener callers
    // must not crash); the record is rolled back so a retry can re-settle.
    expect(result.handled).toBe(true);
    expect(result.record?.paymentHash).toBe(HASH);
    expect(purchases.rollbacks).toEqual([HASH]);
    expect(purchases.record?.status).toBe('pending');
    expect(alerter.alerts.map((a) => a.key)).toEqual(['archive-enqueue-failed']);
    expect(alerter.alerts[0].severity).toBe('warning');
    expect(alerter.alerts[0].body).toContain('rpush failed');
    expect(log.errors.some((m) => m.includes('rolling back to pending'))).toBe(true);
  });

  it('escalates to a critical alert when the rollback itself fails — record stays paid', async () => {
    const purchases = new FakePurchaseStore();
    purchases.seed(HASH);
    purchases.failEnqueue = true;
    purchases.failRollback = true;
    const alerter = new FakeAlerter();
    const log = fakeLog();
    const result = await run(purchases, alerter, log);
    expect(result.handled).toBe(true);
    const keys = alerter.alerts.map((a) => a.key).sort();
    expect(keys).toEqual(['archive-enqueue-failed', 'archive-rollback-failed']);
    const critical = alerter.alerts.find((a) => a.key === 'archive-rollback-failed');
    expect(critical?.severity).toBe('critical');
    expect(critical?.body).toContain('rollback redis down');
    expect(purchases.record?.status).toBe('paid');
    expect(log.errors.some((m) => m.includes('manual reconcile required'))).toBe(true);
  });
});
