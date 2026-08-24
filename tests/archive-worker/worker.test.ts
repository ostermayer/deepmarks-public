import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from '@src/worker.js';
import type { ArchiveFileRecord, ArchiveJob, DoneRecord } from '@src/queue.js';

const mocks = vi.hoisted(() => ({
  downloadVideoArchive: vi.fn(),
  fetchWaybackIfFresh: vi.fn(),
  resolveSafePublicHttpUrl: vi.fn(),
  assertSafePublicHttpUrl: vi.fn(),
}));

vi.mock('@src/youtube.js', () => ({
  downloadVideoArchive: mocks.downloadVideoArchive,
}));

vi.mock('@src/wayback.js', () => ({
  fetchWaybackIfFresh: mocks.fetchWaybackIfFresh,
}));

vi.mock('@src/safe-url.js', () => ({
  UnsafeUrlError: class UnsafeUrlError extends Error {},
  resolveSafePublicHttpUrl: mocks.resolveSafePublicHttpUrl,
  assertSafePublicHttpUrl: mocks.assertSafePublicHttpUrl,
  safeFetch: vi.fn((input: URL | string, init?: RequestInit) => globalThis.fetch(input as RequestInfo, init)),
}));

interface WorkerHarness {
  config: {
    blossomPrimaryUrl: string;
    blossomMirrorUrls: string[];
    waybackMaxAgeDays?: number;
    archiveAuditStaleAfterSeconds?: number;
    archiveAuditMaxJobsPerPass?: number;
    archiveAuditMaxRuntimeMs?: number;
  };
  blossom: {
    upload: ReturnType<typeof vi.fn>;
    uploadFile?: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
    mirror: ReturnType<typeof vi.fn>;
    mirrorFile?: ReturnType<typeof vi.fn>;
  };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  notifyPaymentProxy: ReturnType<typeof vi.fn>;
  processVideoJob(job: ArchiveJob, queue: FakeQueue): Promise<void>;
  runArchiveAuditPass(): Promise<{
    scanned: number;
    failed: number;
    rescued: number;
    requeued?: number;
    requeueDeferred?: number;
    errors: number;
    renotified?: number;
    renotifyDeferred?: number;
    rescueDeferred?: number;
    truncated?: boolean;
  }>;
}

interface FakeQueue {
  audit: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
}

const blobHash = 'a'.repeat(64);
const sidecarHash = 'd'.repeat(64);
const mirrorResult = [{ url: 'https://mirror.deepmarks.org', ok: true }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveSafePublicHttpUrl.mockImplementation(async (raw: string) => new URL(raw));
  mocks.assertSafePublicHttpUrl.mockImplementation(async (raw: string) => new URL(raw));
  mocks.downloadVideoArchive.mockResolvedValue({
    blob: Buffer.from('downloaded-media'),
    title: 'Archive Test',
    channel: 'Deepmarks',
    durationSeconds: 42,
    mediaKind: 'video',
    contentType: 'video/mp4',
  });
  mocks.fetchWaybackIfFresh.mockReset();
});

describe('Worker media archive path', () => {
  it('verifies and mirrors encrypted media before recording success', async () => {
    mocks.downloadVideoArchive.mockResolvedValueOnce({
      blob: Buffer.from('downloaded-media'),
      title: 'Archive Test',
      channel: 'Deepmarks',
      durationSeconds: 42,
      mediaKind: 'video',
      contentType: 'video/mp4',
      sidecars: [{
        role: 'metadata',
        bytes: Buffer.from('{"title":"Archive Test"}'),
        contentType: 'application/json',
        fileName: 'sidecar.info.json',
      }],
    });
    const upload = vi.fn()
      .mockResolvedValueOnce({ blobHash, primaryUrl: 'https://blossom.deepmarks.org', size: 58 })
      .mockResolvedValueOnce({ blobHash: sidecarHash, primaryUrl: 'https://blossom.deepmarks.org', size: 41 });
    const verify = vi.fn(async () => ({ ok: true, status: 200, size: 58 }));
    const mirror = vi.fn(async () => mirrorResult);
    const notifyPaymentProxy = vi.fn(async () => undefined);
    const complete = vi.fn(async (_record: DoneRecord) => undefined);
    const queue: FakeQueue = {
      audit: vi.fn(async () => undefined),
      complete,
    };

    const worker = Object.create(Worker.prototype) as WorkerHarness;
    worker.config = {
      blossomPrimaryUrl: 'https://blossom.deepmarks.org',
      blossomMirrorUrls: ['https://mirror.deepmarks.org'],
    };
    worker.blossom = { upload, verify, mirror };
    worker.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    worker.notifyPaymentProxy = notifyPaymentProxy;

    const job: ArchiveJob = {
      jobId: 'media:' + '1'.repeat(32),
      paymentHash: 'media:' + '1'.repeat(32),
      ownerPubkey: 'b'.repeat(64),
      url: 'https://video.example/watch/1',
      tier: 'private',
      archiveKey: Buffer.alloc(32, 1).toString('base64'),
      attempts: 0,
      enqueuedAt: 1,
      kind: 'media',
      videoContentKey: 'video:' + 'c'.repeat(64),
      bookmarkSavedAt: 1_700_000_000,
    };

    await worker.processVideoJob(job, queue);

    expect(verify).toHaveBeenCalledWith(blobHash);
    expect(verify).toHaveBeenCalledWith(sidecarHash);
    expect(mirror).toHaveBeenCalledWith(
      blobHash,
      ['https://mirror.deepmarks.org'],
      expect.any(Buffer),
      'application/octet-stream',
    );
    expect(mirror).toHaveBeenCalledWith(
      sidecarHash,
      ['https://mirror.deepmarks.org'],
      expect.any(Buffer),
      'application/octet-stream',
    );

    expect(notifyPaymentProxy).toHaveBeenCalledWith(expect.objectContaining({
      jobId: job.jobId,
      status: 'ok',
      blobHash,
      tier: 'private',
      kind: 'media',
      contentType: 'video/mp4',
      mirrors: mirrorResult,
      files: expect.arrayContaining([
        expect.objectContaining({
          role: 'media',
          blobHash,
          contentType: 'video/mp4',
          mirrors: mirrorResult,
        }) as ArchiveFileRecord,
        expect.objectContaining({
          role: 'file',
          blobHash: sidecarHash,
          contentType: 'application/json',
          fileName: 'sidecar.info.json',
          mirrors: mirrorResult,
        }) as ArchiveFileRecord,
      ]),
    }));
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      jobId: job.jobId,
      status: 'ok',
      blobHash,
      files: expect.arrayContaining([
        expect.objectContaining({
          role: 'media',
          blobHash,
          mirrors: mirrorResult,
        }) as ArchiveFileRecord,
        expect.objectContaining({
          role: 'file',
          blobHash: sidecarHash,
          contentType: 'application/json',
          fileName: 'sidecar.info.json',
        }) as ArchiveFileRecord,
      ]),
    }));
  });

  it('streams file-backed yt-dlp media through file upload and cleans temp files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deepmarks-media-test-'));
    const mediaPath = join(dir, 'archive.mp4');
    await writeFile(mediaPath, Buffer.from('downloaded file-backed media'));
    const cleanup = vi.fn(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    mocks.downloadVideoArchive.mockResolvedValueOnce({
      filePath: mediaPath,
      byteLength: Buffer.byteLength('downloaded file-backed media'),
      cleanup,
      title: 'File Backed',
      channel: 'Deepmarks',
      durationSeconds: 12,
      mediaKind: 'video',
      contentType: 'video/mp4',
    });

    const upload = vi.fn();
    const uploadFile = vi.fn(async (path: string, contentType: string) => {
      expect(path).toBe(`${mediaPath}.dmchunk`);
      expect(contentType).toBe('application/octet-stream');
      expect((await stat(path)).size).toBeGreaterThan(0);
      return { blobHash, primaryUrl: 'https://blossom.deepmarks.org', size: 72 };
    });
    const verify = vi.fn(async () => ({ ok: true, status: 200, size: 72 }));
    const mirror = vi.fn();
    const mirrorFile = vi.fn(async (hash: string, urls: string[], path: string, contentType: string) => {
      expect(hash).toBe(blobHash);
      expect(urls).toEqual(['https://mirror.deepmarks.org']);
      expect(path).toBe(`${mediaPath}.dmchunk`);
      expect(contentType).toBe('application/octet-stream');
      return mirrorResult;
    });
    const notifyPaymentProxy = vi.fn(async () => undefined);
    const complete = vi.fn(async (_record: DoneRecord) => undefined);
    const queue: FakeQueue = {
      audit: vi.fn(async () => undefined),
      complete,
    };

    const worker = Object.create(Worker.prototype) as WorkerHarness;
    worker.config = {
      blossomPrimaryUrl: 'https://blossom.deepmarks.org',
      blossomMirrorUrls: ['https://mirror.deepmarks.org'],
      mediaArchiveMaxBytes: 2 * 1024 * 1024 * 1024,
    };
    worker.blossom = { upload, uploadFile, verify, mirror, mirrorFile };
    worker.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    worker.notifyPaymentProxy = notifyPaymentProxy;

    const job: ArchiveJob = {
      jobId: 'media:' + '4'.repeat(32),
      paymentHash: 'media:' + '4'.repeat(32),
      ownerPubkey: 'b'.repeat(64),
      url: 'https://video.example/watch/4',
      tier: 'private',
      archiveKey: Buffer.alloc(32, 1).toString('base64'),
      attempts: 0,
      enqueuedAt: 1,
      kind: 'media',
      videoContentKey: 'video:' + 'e'.repeat(64),
    };

    await worker.processVideoJob(job, queue);

    expect(upload).not.toHaveBeenCalled();
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(mirror).not.toHaveBeenCalled();
    expect(mirrorFile).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(notifyPaymentProxy).toHaveBeenCalledWith(expect.objectContaining({
      jobId: job.jobId,
      status: 'ok',
      blobHash,
      kind: 'media',
    }));
  });

  it('treats provider auth blocks as permanent media failures', async () => {
    mocks.downloadVideoArchive.mockRejectedValueOnce(new Error(
      'yt-dlp exited 1: ERROR: [youtube] abcDEF123_4: Sign in to confirm you’re not a bot.',
    ));
    const notifyPaymentProxy = vi.fn(async () => undefined);
    const complete = vi.fn(async (_record: DoneRecord) => undefined);
    const queue: FakeQueue = {
      audit: vi.fn(async () => undefined),
      complete,
    };

    const worker = Object.create(Worker.prototype) as WorkerHarness;
    worker.config = {
      blossomPrimaryUrl: 'https://blossom.deepmarks.org',
      blossomMirrorUrls: [],
    };
    worker.blossom = {
      upload: vi.fn(),
      verify: vi.fn(),
      mirror: vi.fn(),
    };
    worker.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    worker.notifyPaymentProxy = notifyPaymentProxy;

    const job: ArchiveJob = {
      jobId: 'media:' + '2'.repeat(32),
      paymentHash: 'media:' + '2'.repeat(32),
      ownerPubkey: 'b'.repeat(64),
      url: 'https://www.youtube.com/watch?v=abcDEF123_4',
      tier: 'private',
      archiveKey: Buffer.alloc(32, 1).toString('base64'),
      attempts: 0,
      enqueuedAt: 1,
      kind: 'media',
      videoId: 'abcDEF123_4',
      videoContentKey: 'yt:abcdef123_4',
    };

    await worker.processVideoJob(job, queue);

    expect(notifyPaymentProxy).toHaveBeenCalledWith(expect.objectContaining({
      jobId: job.jobId,
      status: 'failed',
      errorCategory: 'permanent',
    }));
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      jobId: job.jobId,
      status: 'failed',
      errorCategory: 'permanent',
    }));
  });

  it('keeps terminal failure callback delivery pending when Box A notification fails', async () => {
    mocks.downloadVideoArchive.mockRejectedValueOnce(new Error(
      'yt-dlp exited 1: ERROR: [youtube] abcDEF123_4: Sign in to confirm you’re not a bot.',
    ));
    const notifyPaymentProxy = vi.fn(async () => {
      throw new Error('payment-proxy unavailable');
    });
    const complete = vi.fn(async (_record: DoneRecord) => undefined);
    const queue: FakeQueue = {
      audit: vi.fn(async () => undefined),
      complete,
    };

    const worker = Object.create(Worker.prototype) as WorkerHarness;
    worker.config = {
      blossomPrimaryUrl: 'https://blossom.deepmarks.org',
      blossomMirrorUrls: [],
    };
    worker.blossom = {
      upload: vi.fn(),
      verify: vi.fn(),
      mirror: vi.fn(),
    };
    worker.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    worker.notifyPaymentProxy = notifyPaymentProxy;

    const job: ArchiveJob = {
      jobId: 'media:' + '3'.repeat(32),
      paymentHash: 'media:' + '3'.repeat(32),
      ownerPubkey: 'b'.repeat(64),
      url: 'https://www.youtube.com/watch?v=abcDEF123_4',
      tier: 'private',
      archiveKey: Buffer.alloc(32, 1).toString('base64'),
      attempts: 0,
      enqueuedAt: 1,
      kind: 'media',
      videoId: 'abcDEF123_4',
      videoContentKey: 'yt:abcdef123_4',
      bookmarkSavedAt: 1_700_000_001,
    };

    await worker.processVideoJob(job, queue);

    expect(notifyPaymentProxy).toHaveBeenCalledWith(expect.objectContaining({
      jobId: job.jobId,
      status: 'failed',
      errorCategory: 'permanent',
    }));
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      jobId: job.jobId,
      status: 'failed',
      errorCategory: 'permanent',
      callbackPending: true,
      bookmarkSavedAt: 1_700_000_001,
    }));
  });
});

describe('Worker archive audit summary', () => {
  it('summarizes failed public webpage archives without blocking on Wayback repair', async () => {
    const jobId = 'lifetime:' + '2'.repeat(32);
    const redis = makeFakeRedis({
      strings: {
        [`dm:archive-job:${jobId}`]: JSON.stringify({
          jobId,
          paymentHash: jobId,
          ownerPubkey: 'b'.repeat(64),
          url: 'https://blocked.example/article',
          tier: 'public',
          enqueuedAt: 1_700_000_000,
          kind: 'webpage',
          amountSats: 0,
        }),
        [`dm:archive:done:${jobId}`]: JSON.stringify({
          jobId,
          status: 'failed',
          error: 'render blocked',
          completedAt: 1_700_000_100,
        }),
      },
    });

    const upload = vi.fn(async () => ({ blobHash, primaryUrl: 'https://blossom.deepmarks.org', size: 34 }));
    const verify = vi.fn(async () => ({ ok: true, status: 200, size: 34 }));
    const mirror = vi.fn(async () => mirrorResult);
    const notifyPaymentProxy = vi.fn(async () => undefined);
    const complete = vi.fn(async (_record: DoneRecord) => undefined);

    const worker = Object.create(Worker.prototype) as WorkerHarness & {
      redis: ReturnType<typeof makeFakeRedis>;
      queue: FakeQueue;
    };
    worker.config = {
      blossomPrimaryUrl: 'https://blossom.deepmarks.org',
      blossomMirrorUrls: ['https://mirror.deepmarks.org'],
      waybackMaxAgeDays: 90,
      archiveAuditStaleAfterSeconds: 60,
      archiveAuditMaxJobsPerPass: 100,
      archiveAuditMaxRuntimeMs: 60_000,
    };
    worker.redis = redis;
    worker.queue = {
      audit: vi.fn(async () => undefined),
      complete,
    };
    worker.blossom = { upload, verify, mirror };
    worker.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    worker.notifyPaymentProxy = notifyPaymentProxy;

    const summary = await worker.runArchiveAuditPass();

    // The audit pass now ATTEMPTS the Wayback rescue (claim-key guarded)
    // instead of deferring forever; with no fresh snapshot it records a
    // miss and leaves no side effects.
    expect(summary).toMatchObject({
      scanned: 1,
      failed: 1,
      rescueDeferred: 0,
      rescued: 0,
      waybackMiss: 1,
      errors: 0,
      truncated: false,
    });
    await expect(redis.get('dm:archive-audit:last')).resolves.toContain('"waybackMiss":1');
    expect(mocks.fetchWaybackIfFresh).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
    expect(notifyPaymentProxy).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('writes a summary for completed jobs that need callback re-notify', async () => {
    const jobId = 'lifetime:' + '3'.repeat(32);
    const redis = makeFakeRedis({
      strings: {
        [`dm:archive-job:${jobId}`]: JSON.stringify({
          jobId,
          paymentHash: jobId,
          ownerPubkey: 'c'.repeat(64),
          url: 'https://blocked.example/deferred',
          tier: 'public',
          enqueuedAt: 1_700_000_000,
          kind: 'webpage',
          amountSats: 0,
        }),
        [`dm:archive:done:${jobId}`]: JSON.stringify({
          jobId,
          status: 'ok',
          blobHash,
          source: 'rendered',
          completedAt: 1_700_000_100,
        }),
      },
    });

    const worker = Object.create(Worker.prototype) as WorkerHarness & {
      redis: ReturnType<typeof makeFakeRedis>;
      queue: FakeQueue;
    };
    worker.config = {
      blossomPrimaryUrl: 'https://blossom.deepmarks.org',
      blossomMirrorUrls: [],
      waybackMaxAgeDays: 90,
      archiveAuditStaleAfterSeconds: 60,
      archiveAuditMaxJobsPerPass: 100,
      archiveAuditMaxRuntimeMs: 60_000,
    };
    worker.redis = redis;
    worker.queue = {
      audit: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
    };
    worker.blossom = { upload: vi.fn(), verify: vi.fn(), mirror: vi.fn() };
    worker.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    worker.notifyPaymentProxy = vi.fn(async () => undefined);

    const summary = await worker.runArchiveAuditPass();

    // The audit pass now repairs the lost callback: the archive exists on
    // Blossom but never reached the account index, so it re-notifies the
    // proxy (claim-key guarded) instead of deferring forever.
    expect(summary).toMatchObject({
      scanned: 1,
      failed: 0,
      renotified: 1,
      renotifyDeferred: 0,
      errors: 0,
      truncated: false,
    });
    expect(worker.notifyPaymentProxy).toHaveBeenCalledTimes(1);
    await expect(redis.get('dm:archive-audit:last')).resolves.toContain('"renotified":1');
  });

  it('retries pending failure callbacks from durable done records', async () => {
    const jobId = 'lifetime:' + '9'.repeat(32);
    const ownerPubkey = '9'.repeat(64);
    const redis = makeFakeRedis({
      strings: {
        [`dm:archive-job:${jobId}`]: JSON.stringify({
          jobId,
          paymentHash: jobId,
          ownerPubkey,
          url: 'https://example.com/terminal-failure',
          tier: 'public',
          enqueuedAt: 1_700_000_000,
          kind: 'webpage',
          amountSats: 0,
        }),
        [`dm:archive:done:${jobId}`]: JSON.stringify({
          jobId,
          status: 'failed',
          error: 'payment-proxy notification failed',
          errorCategory: 'permanent',
          callbackPending: true,
          completedAt: 1_700_000_100,
        }),
      },
    });

    const worker = Object.create(Worker.prototype) as WorkerHarness & {
      redis: ReturnType<typeof makeFakeRedis>;
      queue: FakeQueue;
    };
    worker.config = {
      blossomPrimaryUrl: 'https://blossom.deepmarks.org',
      blossomMirrorUrls: [],
      waybackMaxAgeDays: 90,
      archiveAuditStaleAfterSeconds: 60,
      archiveAuditMaxJobsPerPass: 100,
      archiveAuditMaxRuntimeMs: 60_000,
    };
    worker.redis = redis;
    worker.queue = {
      audit: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
    };
    worker.blossom = { upload: vi.fn(), verify: vi.fn(), mirror: vi.fn() };
    worker.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    worker.notifyPaymentProxy = vi.fn(async () => undefined);

    const summary = await worker.runArchiveAuditPass();
    const done = JSON.parse((await redis.get(`dm:archive:done:${jobId}`))!);

    expect(summary).toMatchObject({
      scanned: 1,
      failed: 1,
      renotified: 1,
      renotifyDeferred: 0,
      errors: 0,
    });
    expect(worker.notifyPaymentProxy).toHaveBeenCalledWith(expect.objectContaining({
      jobId,
      status: 'failed',
      ownerPubkey,
      paymentHash: jobId,
      errorCategory: 'permanent',
    }));
    expect(done.callbackPending).toBe(false);
    expect(worker.queue.audit).toHaveBeenCalledWith(jobId, 'failure-renotified');
  });

  it('requeues stale public archive jobs from metadata', async () => {
    const jobId = 'lifetime:' + '4'.repeat(32);
    const ownerPubkey = 'd'.repeat(64);
    const redis = makeFakeRedis({
      strings: {
        [`dm:archive-job:${jobId}`]: JSON.stringify({
          jobId,
          paymentHash: jobId,
          ownerPubkey,
          url: 'https://academic.oup.com/bioscience/advance-article/doi/10.1093/biosci/biaf050/8116758',
          tier: 'public',
          mirrorUrls: ['https://mirror.deepmarks.org'],
          enqueuedAt: 1_700_000_000,
          bookmarkSavedAt: 1_700_000_001,
          kind: 'webpage',
          amountSats: 0,
        }),
      },
    });

    const worker = Object.create(Worker.prototype) as WorkerHarness & {
      redis: ReturnType<typeof makeFakeRedis>;
      queue: FakeQueue;
    };
    worker.config = {
      blossomPrimaryUrl: 'https://blossom.deepmarks.org',
      blossomMirrorUrls: [],
      waybackMaxAgeDays: 90,
      archiveAuditStaleAfterSeconds: 60,
      archiveAuditMaxJobsPerPass: 100,
      archiveAuditMaxRuntimeMs: 60_000,
    };
    worker.redis = redis;
    worker.queue = {
      audit: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
    };
    worker.blossom = { upload: vi.fn(), verify: vi.fn(), mirror: vi.fn() };
    worker.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    worker.notifyPaymentProxy = vi.fn(async () => undefined);

    const summary = await worker.runArchiveAuditPass();
    const queued = await redis.lrange('dm:archive:queue', 0, -1);
    const requeued = JSON.parse(queued[0]!) as ArchiveJob;

    expect(summary).toMatchObject({
      scanned: 1,
      stale: 1,
      requeued: 1,
      requeueDeferred: 0,
      rescueDeferred: 0,
      errors: 0,
      truncated: false,
    });
    expect(requeued).toMatchObject({
      jobId,
      paymentHash: jobId,
      ownerPubkey,
      tier: 'public',
      archiveKey: null,
      attempts: 0,
      bookmarkSavedAt: 1_700_000_001,
      kind: 'webpage',
      mirrorUrls: ['https://mirror.deepmarks.org'],
    });
    expect(worker.queue.audit).toHaveBeenCalledWith(jobId, 'lost-job-requeued', {
      reason: 'stale-without-live-job',
      source: 'metadata',
    });
  });

  it('recognizes done jobs already present in the account archive index by blob hash', async () => {
    const jobId = 'lifetime:' + '5'.repeat(32);
    const ownerPubkey = 'e'.repeat(64);
    const redis = makeFakeRedis({
      strings: {
        [`dm:archive-job:${jobId}`]: JSON.stringify({
          jobId,
          paymentHash: jobId,
          ownerPubkey,
          url: 'https://example.com/recorded',
          tier: 'public',
          enqueuedAt: 1_700_000_000,
          kind: 'webpage',
          amountSats: 0,
        }),
        [`dm:archive:done:${jobId}`]: JSON.stringify({
          jobId,
          status: 'ok',
          blobHash,
          source: 'rendered',
          completedAt: 1_700_000_100,
        }),
      },
      hashes: {
        [`dm:archives:${ownerPubkey}`]: {
          [blobHash]: JSON.stringify({ jobId, blobHash, ownerPubkey }),
        },
      },
    });

    const worker = Object.create(Worker.prototype) as WorkerHarness & {
      redis: ReturnType<typeof makeFakeRedis>;
      queue: FakeQueue;
    };
    worker.config = {
      blossomPrimaryUrl: 'https://blossom.deepmarks.org',
      blossomMirrorUrls: [],
      waybackMaxAgeDays: 90,
      archiveAuditStaleAfterSeconds: 60,
      archiveAuditMaxJobsPerPass: 100,
      archiveAuditMaxRuntimeMs: 60_000,
    };
    worker.redis = redis;
    worker.queue = {
      audit: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
    };
    worker.blossom = { upload: vi.fn(), verify: vi.fn(), mirror: vi.fn() };
    worker.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    worker.notifyPaymentProxy = vi.fn(async () => undefined);

    const summary = await worker.runArchiveAuditPass();

    expect(summary).toMatchObject({
      scanned: 1,
      completed: 1,
      renotifyDeferred: 0,
      errors: 0,
      truncated: false,
    });
    expect(redis.hexists).toHaveBeenCalledWith(`dm:archives:${ownerPubkey}`, blobHash);
    expect(redis.hvals).not.toHaveBeenCalled();
  });
});

function makeFakeRedis(input: {
  strings?: Record<string, string>;
  lists?: Record<string, string[]>;
  hashes?: Record<string, Record<string, string>>;
} = {}) {
  const strings = new Map(Object.entries(input.strings ?? {}));
  const lists = new Map(Object.entries(input.lists ?? {}));
  const hashes = new Map(
    Object.entries(input.hashes ?? {}).map(([key, value]) => [key, new Map(Object.entries(value))]),
  );
  const allKeys = (): string[] => [...strings.keys(), ...lists.keys(), ...hashes.keys()];
  const redis = {
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      return ['0', allKeys().filter((key) => key.startsWith(prefix))] as [string, string[]];
    }),
    mget: vi.fn(async (...keys: string[]) => keys.map((key) => strings.get(key) ?? null)),
    get: vi.fn(async (key: string) => strings.get(key) ?? null),
    exists: vi.fn(async (key: string) => strings.has(key) ? 1 : 0),
    hexists: vi.fn(async (key: string, field: string) => hashes.get(key)?.has(field) ? 1 : 0),
    hvals: vi.fn(async (key: string) => [...(hashes.get(key)?.values() ?? [])]),
    lrange: vi.fn(async (key: string, _start = 0, _stop = -1) => lists.get(key) ?? []),
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      const nx = args.some((arg) => String(arg).toUpperCase() === 'NX');
      if (nx && strings.has(key)) return null;
      strings.set(key, value);
      return 'OK';
    }),
    rpush: vi.fn(async (key: string, value: string) => {
      const current = lists.get(key) ?? [];
      current.push(value);
      lists.set(key, current);
      return current.length;
    }),
    del: vi.fn(async (key: string) => {
      const existed = Number(strings.delete(key)) + Number(lists.delete(key)) + Number(hashes.delete(key));
      return existed;
    }),
  };
  return {
    ...redis,
    pipeline: vi.fn(() => {
      const calls: Array<{ name: 'exists' | 'get' | 'hexists' | 'set'; args: unknown[] }> = [];
      const pipe = {
        exists: vi.fn((key: string) => {
          calls.push({ name: 'exists', args: [key] });
          return pipe;
        }),
        get: vi.fn((key: string) => {
          calls.push({ name: 'get', args: [key] });
          return pipe;
        }),
        hexists: vi.fn((key: string, field: string) => {
          calls.push({ name: 'hexists', args: [key, field] });
          return pipe;
        }),
        set: vi.fn((key: string, value: string, ...args: unknown[]) => {
          calls.push({ name: 'set', args: [key, value, ...args] });
          return pipe;
        }),
        exec: vi.fn(async () => {
          const results: Array<[Error | null, unknown]> = [];
          for (const call of calls) {
            try {
              if (call.name === 'exists') results.push([null, await redis.exists(call.args[0] as string)]);
              if (call.name === 'get') results.push([null, await redis.get(call.args[0] as string)]);
              if (call.name === 'hexists') {
                results.push([null, await redis.hexists(call.args[0] as string, call.args[1] as string)]);
              }
              if (call.name === 'set') {
                results.push([null, await redis.set(call.args[0] as string, call.args[1] as string, ...call.args.slice(2))]);
              }
            } catch (err) {
              results.push([err as Error, null]);
            }
          }
          return results;
        }),
      };
      return pipe;
    }),
  };
}

describe('Worker archive audit — truncated live scan (2026-08-23 review #5)', () => {
  it('defers the stale Wayback rescue when the live-job id scan truncated', async () => {
    // With the live scan truncated, "not seen live" is meaningless: the
    // stale branch used to claim + upload a stale Wayback snapshot for a
    // job whose live render was still in flight, and the real render's
    // callback then dropped as a duplicate.
    const staleId = 'lifetime:' + 'a'.repeat(32);
    const liveJob = (id: string) => JSON.stringify({
      jobId: id,
      paymentHash: id,
      ownerPubkey: 'b'.repeat(64),
      url: `https://example.com/${id.slice(-4)}`,
      tier: 'public',
      enqueuedAt: 1_700_000_000,
      kind: 'webpage',
      amountSats: 0,
    });
    const redis = makeFakeRedis({
      lists: {
        'dm:archive:queue': [liveJob('lifetime:' + '1'.repeat(32)), liveJob('lifetime:' + '2'.repeat(32))],
      },
      strings: {
        [`dm:archive-job:${staleId}`]: JSON.stringify({
          jobId: staleId,
          paymentHash: staleId,
          ownerPubkey: 'b'.repeat(64),
          url: 'https://example.com/stale-rescuable',
          tier: 'public',
          enqueuedAt: 1_700_000_000,
          kind: 'webpage',
          amountSats: 0,
        }),
      },
    });

    const upload = vi.fn(async () => ({ blobHash, primaryUrl: 'https://blossom.deepmarks.org', size: 34 }));
    const worker = Object.create(Worker.prototype) as WorkerHarness & {
      redis: ReturnType<typeof makeFakeRedis>;
      queue: FakeQueue;
    };
    worker.config = {
      blossomPrimaryUrl: 'https://blossom.deepmarks.org',
      blossomMirrorUrls: [],
      waybackMaxAgeDays: 90,
      archiveAuditStaleAfterSeconds: 60,
      // Cap of 2 with 2 live queue entries => live id scan truncates.
      archiveAuditMaxJobsPerPass: 2,
      archiveAuditMaxRuntimeMs: 60_000,
    };
    worker.redis = redis;
    worker.queue = { audit: vi.fn(async () => undefined), complete: vi.fn(async () => undefined) };
    worker.blossom = { upload, verify: vi.fn(), mirror: vi.fn() };
    worker.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    worker.notifyPaymentProxy = vi.fn(async () => undefined);

    const summary = await worker.runArchiveAuditPass();

    expect(summary.truncated).toBe(true);
    // Proves the stale meta was scanned and classified — not skipped by
    // some earlier cap — and then landed in skippedNonRescuable instead
    // of the rescue branch.
    expect(summary.scanned).toBe(1);
    expect(summary.stale).toBe(1);
    expect(summary.skippedNonRescuable).toBe(1);
    expect(summary.rescued).toBe(0);
    expect(summary.waybackMiss).toBe(0);
    expect(mocks.fetchWaybackIfFresh).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
});
