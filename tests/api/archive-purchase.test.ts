import { describe, expect, it } from 'vitest';

import { enqueueLifetimeArchive } from '@src/archive-purchase.js';
import type { PurchaseStore } from '@src/queue.js';
import type { PurchaseRecord } from '@src/types.js';

class FakePurchaseStore {
  record: PurchaseRecord | null = null;
  queued: PurchaseRecord[] = [];
  rollbacks: string[] = [];
  failEnqueue = false;

  async create(record: PurchaseRecord): Promise<void> {
    this.record = { ...record };
  }

  async markPaid(paymentHash: string): Promise<PurchaseRecord | null> {
    if (!this.record || this.record.paymentHash !== paymentHash) return null;
    this.record.status = 'paid';
    this.record.paidAt = 1_700_000_001;
    return this.record;
  }

  async enqueueArchiveJob(record: PurchaseRecord): Promise<void> {
    if (this.failEnqueue) throw new Error('rpush failed');
    this.queued.push(record);
  }

  async rollbackToPending(paymentHash: string): Promise<void> {
    this.rollbacks.push(paymentHash);
    if (this.record?.paymentHash === paymentHash) {
      this.record.status = 'pending';
      this.record.paidAt = undefined;
    }
  }
}

describe('enqueueLifetimeArchive', () => {
  it('rolls the record back to pending when queueing fails after markPaid', async () => {
    const purchases = new FakePurchaseStore();
    purchases.failEnqueue = true;

    await expect(enqueueLifetimeArchive({
      purchases: purchases as unknown as PurchaseStore,
      url: 'https://example.com/post',
      userPubkey: 'a'.repeat(64),
      paymentHash: 'lifetime:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      tier: 'public',
    })).rejects.toThrow('rpush failed');

    expect(purchases.rollbacks).toEqual(['lifetime:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(purchases.record?.status).toBe('pending');
    expect(purchases.record?.paidAt).toBeUndefined();
    expect(purchases.queued).toHaveLength(0);
  });
});
