import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/api/client', () => ({
  api: {
    purchaseArchive: vi.fn(),
    archiveStatus: vi.fn()
  },
  ApiError: class extends Error {}
}));
vi.mock('./zap.js', () => ({
  payInvoicesWithWebLN: vi.fn()
}));

import { purchaseArchive, type ArchiveProgress } from './archive.js';
import { api } from '$lib/api/client';
import { payInvoicesWithWebLN } from './zap.js';

const mockedPurchase = api.purchaseArchive as unknown as ReturnType<typeof vi.fn>;
const mockedStatus = api.archiveStatus as unknown as ReturnType<typeof vi.fn>;
const mockedPay = payInvoicesWithWebLN as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedPurchase.mockReset();
  mockedStatus.mockReset();
  mockedPay.mockReset();
});

describe('purchaseArchive', () => {
  it('walks pending → queued → archiving → done and returns the outcome', async () => {
    mockedPurchase.mockResolvedValue({
      invoice: 'lnbc1...',
      paymentHash: 'abc',
      jobId: 'job-1',
      amountSats: 500
    });
    mockedPay.mockResolvedValue(['preimage-deadbeef']);
    mockedStatus
      .mockResolvedValueOnce({ jobId: 'job-1', state: 'queued' })
      .mockResolvedValueOnce({ jobId: 'job-1', state: 'archiving' })
      .mockResolvedValueOnce({ jobId: 'job-1', state: 'done', blossomHash: 'sha256-xyz' });

    const iter = purchaseArchive({
      url: 'https://x.test',
      tier: 'private',
      pubkey: 'pub',
      timeoutMs: 60_000
    });

    const progress: ArchiveProgress[] = [];
    let outcome;
    while (true) {
      const next = await iter.next();
      if (next.done) {
        outcome = next.value;
        break;
      }
      progress.push(next.value);
    }

    expect(progress.map((p) => p.state)).toEqual([
      'pending-payment',
      'pending-payment',
      'queued',
      'archiving',
      'done'
    ]);
    expect(outcome?.preimage).toBe('preimage-deadbeef');
    expect(outcome?.status.blossomHash).toBe('sha256-xyz');
  });

  it('throws if the worker reports failed', async () => {
    mockedPurchase.mockResolvedValue({ invoice: 'x', paymentHash: 'h', jobId: 'j', amountSats: 500 });
    mockedPay.mockResolvedValue(['preimage']);
    mockedStatus.mockResolvedValueOnce({ jobId: 'j', state: 'failed', error: 'paywall detected' });

    const iter = purchaseArchive({ url: 'https://x', tier: 'public', pubkey: 'p' });
    await expect((async () => {
      while (true) {
        const next = await iter.next();
        if (next.done) return;
      }
    })()).rejects.toThrow('paywall detected');
  });

  it('throws on timeout', async () => {
    mockedPurchase.mockResolvedValue({ invoice: 'x', paymentHash: 'h', jobId: 'j', amountSats: 500 });
    mockedPay.mockResolvedValue(['preimage']);
    mockedStatus.mockResolvedValue({ jobId: 'j', state: 'archiving' });

    const iter = purchaseArchive({ url: 'https://x', tier: 'public', pubkey: 'p', timeoutMs: 1 });
    await expect((async () => {
      while (true) {
        const next = await iter.next();
        if (next.done) return;
      }
    })()).rejects.toThrow('timed out');
  });
});
