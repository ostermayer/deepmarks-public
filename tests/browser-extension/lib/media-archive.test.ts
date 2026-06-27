import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isPotentialMediaUrl, queueEligibleMediaArchiveBackfill } from '@src/lib/media-archive.js';

const mocks = vi.hoisted(() => ({
  archiveStatus: vi.fn(),
  getMediaArchiveAddonStatus: vi.fn(),
  startMediaArchive: vi.fn(),
  generateArchiveKey: vi.fn(),
  publishPendingArchiveKey: vi.fn(),
  scheduleArchiveKeyReconcileSoon: vi.fn(),
  stashPendingKey: vi.fn(),
}));

vi.mock('@src/lib/archive.js', () => ({
  archiveStatus: mocks.archiveStatus,
  getMediaArchiveAddonStatus: mocks.getMediaArchiveAddonStatus,
  startMediaArchive: mocks.startMediaArchive,
}));

vi.mock('@src/lib/archive-keys.js', () => ({
  generateArchiveKey: mocks.generateArchiveKey,
  publishPendingArchiveKey: mocks.publishPendingArchiveKey,
  stashPendingKey: mocks.stashPendingKey,
}));

vi.mock('@src/lib/archive-key-reconciler.js', () => ({
  scheduleArchiveKeyReconcileSoon: mocks.scheduleArchiveKeyReconcileSoon,
}));

const storage = new Map<string, unknown>();

function installChromeStorageMock() {
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[] | null) => {
          if (key === null) return Object.fromEntries(storage.entries());
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map((item) => [item, storage.get(item)]));
          }
          return { [key]: storage.get(key) };
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) storage.set(key, value);
        }),
        remove: vi.fn(async (key: string | string[]) => {
          for (const item of Array.isArray(key) ? key : [key]) storage.delete(item);
        }),
      },
    },
  } as unknown as typeof chrome;
}

describe('media archive extension detection', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
    installChromeStorageMock();
    mocks.getMediaArchiveAddonStatus.mockResolvedValue({ purchased: true });
    mocks.generateArchiveKey.mockReturnValue('k'.repeat(64));
    mocks.startMediaArchive.mockResolvedValue({ jobId: 'job-1' });
    mocks.publishPendingArchiveKey.mockResolvedValue(undefined);
    mocks.stashPendingKey.mockResolvedValue(undefined);
  });

  it('treats only real YouTube media URLs as media candidates', () => {
    expect(isPotentialMediaUrl('https://www.youtube.com/watch?v=AbCdEfGhI12')).toBe(true);
    expect(isPotentialMediaUrl('https://youtu.be/AbCdEfGhI12')).toBe(true);
    expect(isPotentialMediaUrl('https://www.youtube.com/shorts/AbCdEfGhI12')).toBe(true);

    expect(isPotentialMediaUrl('https://www.youtube.com/')).toBe(false);
    expect(isPotentialMediaUrl('https://www.youtube.com/@deepmarks')).toBe(false);
    expect(isPotentialMediaUrl('https://music.youtube.com/playlist?list=PL123')).toBe(false);
  });

  it('records terminal media failures and suppresses immediate backfill retries', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=AbCdEfGhI12';
    storage.set('deepmarks-media-archive-queued:v1:yt:abcdefghi12', {
      queuedAt: Date.now(),
      jobId: 'job-failed',
      state: 'queued',
    });
    mocks.archiveStatus.mockResolvedValue({
      status: 'failed',
      state: 'failed',
      message: 'Site blocked the archive capture.',
      error: 'unsupported by provider',
    });

    const result = await queueEligibleMediaArchiveBackfill({
      bookmarks: [{ url: videoUrl, eventId: 'event-1', savedAt: 123 }],
      archives: [],
      nsecHex: '1'.repeat(64),
      pubkey: '2'.repeat(64),
    });

    expect(result).toEqual({ queued: 0, skipped: 1 });
    expect(mocks.archiveStatus).toHaveBeenCalledWith('job-failed');
    expect(mocks.startMediaArchive).not.toHaveBeenCalled();
    expect(storage.has('deepmarks-media-archive-queued:v1:yt:abcdefghi12')).toBe(false);
    expect(storage.get('deepmarks-media-failed:v1')).toEqual({
      'yt:abcdefghi12': expect.objectContaining({
        error: 'Site blocked the archive capture.',
        failedAt: expect.any(Number),
      }),
    });
  });
});
