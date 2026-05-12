import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/api/client', () => ({
  api: {
    enqueueLifetimeArchive: vi.fn(),
    archiveStatus: vi.fn()
  },
  ApiError: class extends Error {}
}));

import { archivePage, type ArchiveProgress } from './archive.js';
import { api } from '$lib/api/client';

const mockedPurchase = api.enqueueLifetimeArchive as unknown as ReturnType<typeof vi.fn>;
const mockedStatus = api.archiveStatus as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedPurchase.mockReset();
  mockedStatus.mockReset();
});

describe('archivePage', () => {
  it('walks pending → queued → archiving → done and returns the outcome', async () => {
    mockedPurchase.mockResolvedValue({
      paymentHash: 'abc',
      jobId: 'job-1',
      amountSats: 0
    });
    mockedStatus
      .mockResolvedValueOnce({ jobId: 'job-1', state: 'queued' })
      .mockResolvedValueOnce({ jobId: 'job-1', state: 'archiving' })
      .mockResolvedValueOnce({ jobId: 'job-1', state: 'done', blossomHash: 'sha256-xyz' });

    const iter = archivePage({
      url: 'https://x.test',
      tier: 'private',
      pubkey: 'pub',
      lifetime: true,
      mirrorUrls: ['https://backup.example.com'],
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
      'queued',
      'archiving',
      'done'
    ]);
    expect(outcome?.preimage).toBe('');
    expect(outcome?.status.blossomHash).toBe('sha256-xyz');
    expect(mockedPurchase).toHaveBeenCalledWith(expect.objectContaining({
      mirrorUrls: ['https://backup.example.com'],
    }));
  });

  it('throws if the worker reports failed', async () => {
    mockedPurchase.mockResolvedValue({ paymentHash: 'h', jobId: 'j', amountSats: 0 });
    mockedStatus.mockResolvedValueOnce({ jobId: 'j', state: 'failed', error: 'paywall detected' });

    const iter = archivePage({ url: 'https://x', tier: 'public', pubkey: 'p', lifetime: true });
    await expect((async () => {
      while (true) {
        const next = await iter.next();
        if (next.done) return;
      }
    })()).rejects.toThrow('paywall detected');
  });

  it('throws on timeout', async () => {
    mockedPurchase.mockResolvedValue({ paymentHash: 'h', jobId: 'j', amountSats: 0 });
    mockedStatus.mockResolvedValue({ jobId: 'j', state: 'archiving' });

    const iter = archivePage({ url: 'https://x', tier: 'public', pubkey: 'p', lifetime: true, timeoutMs: 1 });
    await expect((async () => {
      while (true) {
        const next = await iter.next();
        if (next.done) return;
      }
    })()).rejects.toThrow('timed out');
  });

  it('refuses non-lifetime archive attempts before calling the API', async () => {
    const iter = archivePage({ url: 'https://x', tier: 'public', pubkey: 'p' });
    await expect(iter.next()).rejects.toThrow(/lifetime membership required/);
    expect(mockedPurchase).not.toHaveBeenCalled();
  });
});
