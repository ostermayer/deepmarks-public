import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/api/client', () => ({
  api: {
    enqueueLifetimeArchive: vi.fn(),
    archiveStatus: vi.fn()
  },
  ApiError: class extends Error {}
}));

const archiveKeyMocks = vi.hoisted(() => ({
  addArchiveKeyToSet: vi.fn(),
  clearPendingArchiveKey: vi.fn(),
  generateArchiveKey: vi.fn(() => 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
  publishPendingArchiveKey: vi.fn(),
  stashPendingArchiveKey: vi.fn(),
}));

vi.mock('./archive-keys.js', () => archiveKeyMocks);

import {
  archivePage,
  archiveQueueStats,
  enqueueArchivePage,
  refreshQueuedArchiveStatuses,
  releaseFailedArchiveQueueSlots,
  type ArchiveProgress,
} from './archive.js';
import { api } from '$lib/api/client';
import {
  addArchiveKeyToSet,
  clearPendingArchiveKey,
  generateArchiveKey,
  publishPendingArchiveKey,
  stashPendingArchiveKey,
} from './archive-keys.js';

const mockedPurchase = api.enqueueLifetimeArchive as unknown as ReturnType<typeof vi.fn>;
const mockedStatus = api.archiveStatus as unknown as ReturnType<typeof vi.fn>;
const mockedAddArchiveKeyToSet = addArchiveKeyToSet as unknown as ReturnType<typeof vi.fn>;
const mockedClearPendingArchiveKey = clearPendingArchiveKey as unknown as ReturnType<typeof vi.fn>;
const mockedGenerateArchiveKey = generateArchiveKey as unknown as ReturnType<typeof vi.fn>;
const mockedPublishPendingArchiveKey = publishPendingArchiveKey as unknown as ReturnType<typeof vi.fn>;
const mockedStashPendingArchiveKey = stashPendingArchiveKey as unknown as ReturnType<typeof vi.fn>;

class MapBackedStorage {
  private readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
}

beforeEach(() => {
  mockedPurchase.mockReset();
  mockedStatus.mockReset();
  mockedAddArchiveKeyToSet.mockReset();
  mockedClearPendingArchiveKey.mockReset();
  mockedGenerateArchiveKey.mockReset().mockReturnValue('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  mockedPublishPendingArchiveKey.mockReset().mockResolvedValue(undefined);
  mockedStashPendingArchiveKey.mockReset();
  vi.stubGlobal('localStorage', new MapBackedStorage());
});

describe('archivePage', () => {
  it('stashes private archive keys by job id when key pre-sync cannot publish', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockedPublishPendingArchiveKey.mockRejectedValueOnce(new Error('offline'));
    mockedPurchase.mockResolvedValue({
      paymentHash: 'h',
      jobId: 'job-private',
      amountSats: 0
    });

    const result = await enqueueArchivePage({
      url: 'https://private.example/page',
      tier: 'private',
      pubkey: 'pub',
      lifetime: true,
    });

    expect(result.jobId).toBe('job-private');
    expect(result.archiveKey).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    expect(mockedPurchase).toHaveBeenCalledWith(expect.objectContaining({
      tier: 'private',
      archiveKey: result.archiveKey,
    }));
    expect(mockedStashPendingArchiveKey).toHaveBeenCalledWith('job-private', result.archiveKey);
    expect(mockedPublishPendingArchiveKey).toHaveBeenCalledWith('job-private', result.archiveKey, 'pub');
    warn.mockRestore();
  });

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
      bookmarkSavedAt: 1_700_000_000,
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
      bookmarkSavedAt: 1_700_000_000,
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

  it('releases failed queue slots so backfill can retry them', async () => {
    const url = 'https://retry.example/page';
    mockedPurchase.mockResolvedValueOnce({ paymentHash: 'h1', jobId: 'job-1', amountSats: 0 });
    await enqueueArchivePage({
      url,
      tier: 'public',
      pubkey: 'pub',
      lifetime: true,
      dedupe: true,
    });

    mockedStatus.mockResolvedValueOnce({ jobId: 'job-1', state: 'failed', error: 'timeout' });
    const refreshed = await refreshQueuedArchiveStatuses('pub', [], 10);
    expect(refreshed.failed).toBe(1);
    expect(archiveQueueStats('pub').failedUrls.has(url)).toBe(true);

    expect(releaseFailedArchiveQueueSlots('pub')).toBe(1);
    expect(archiveQueueStats('pub').failedUrls.has(url)).toBe(false);
    expect(archiveQueueStats('pub').queuedUrls.has(url)).toBe(false);

    mockedPurchase.mockResolvedValueOnce({ paymentHash: 'h2', jobId: 'job-2', amountSats: 0 });
    await enqueueArchivePage({
      url,
      tier: 'public',
      pubkey: 'pub',
      lifetime: true,
      dedupe: true,
    });
    expect(mockedPurchase).toHaveBeenCalledTimes(2);
  });
});
