import Redis from 'ioredis';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { getPublicKey, nip19 } from 'nostr-tools';
import {
  ArchiveQueue,
  KEYS,
  MAX_ATTEMPTS,
  type ArchiveDeleteJob,
  type ArchiveJob,
  type DoneRecord,
} from './queue.js';
import { fetchWaybackIfFresh } from './wayback.js';
import { PageRenderer, RenderError } from './renderer.js';
import { encryptBlob, zeroize } from './crypto.js';
import { BlossomClient } from './blossom.js';
import { assertSafePublicHttpUrl, UnsafeUrlError } from './safe-url.js';
import { resolveMirrorTargets } from './mirror-targets.js';
import { downloadYoutubeArchive } from './youtube.js';

/**
 * Main worker loop.
 *
 * Flow per job (matches Flow O in architecture):
 *   1. BLMOVE a job from dm:archive:queue → dm:archive:processing:<wid>
 *   2. Try a live render with Playwright + SingleFile
 *   3. If live capture fails, try Wayback (if snapshot <WAYBACK_MAX_AGE_DAYS days old)
 *   4. If tier=private, AES-256-GCM encrypt with archiveKey
 *   5. Upload to primary Blossom, fan out to mirrors
 *   6. Write done record, publish event, notify payment-proxy
 *
 * Retry: up to MAX_ATTEMPTS attempts. Retryable jobs are pushed to the
 * back of the queue so healthy imports keep draining while the failed URL
 * waits behind the current backlog.
 */

export interface WorkerConfig {
  redisUrl: string;
  blossomPrimaryUrl: string;
  blossomMirrorUrls: string[];
  workerNsec: string;
  paymentProxyUrl: string;
  workerCallbackSecret: string;
  waybackMaxAgeDays: number;
  playwrightNavTimeoutMs: number;
  playwrightRenderTimeoutMs: number;
  playwrightViewport: string;
  heartbeatIntervalMs: number;
  stagedBlobTtlSeconds: number;
  maxConcurrentJobs: number;
  logLevel: string;
}

export class Worker {
  private redis: Redis;
  private queue: ArchiveQueue;
  private renderer: PageRenderer;
  private blossom: BlossomClient;
  private log: pino.Logger;
  private shuttingDown = false;
  private activeJobs = 0;
  private readonly loopQueues = new Set<ArchiveQueue>();

  constructor(private readonly config: WorkerConfig) {
    this.log = pino({ level: config.logLevel, name: 'archive-worker' });

    this.redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });

    this.queue = new ArchiveQueue(this.redis, config.heartbeatIntervalMs);

    const [w, h] = config.playwrightViewport.split('x').map((n) => parseInt(n, 10));
    this.renderer = new PageRenderer({
      navTimeoutMs: config.playwrightNavTimeoutMs,
      renderTimeoutMs: config.playwrightRenderTimeoutMs,
      viewport: { width: w ?? 1280, height: h ?? 800 },
    });

    const privkeyHex = config.workerNsec.startsWith('nsec1')
      ? decodeNsec(config.workerNsec)
      : config.workerNsec;
    const privkey = Uint8Array.from(Buffer.from(privkeyHex, 'hex'));
    const pubkey = getPublicKey(privkey);

    this.blossom = new BlossomClient(config.blossomPrimaryUrl, privkey, pubkey);

    this.log.info({ workerId: this.queue.workerId, pubkey }, 'worker initialized');
  }

  async start(): Promise<void> {
    await this.renderer.init();
    // Recover any jobs left in per-worker processing lists from
    // previous worker incarnations (compose recreate, container OOM,
    // SIGKILL during render). BLMOVE keeps the JSON in
    // dm:archive:processing:<dead-workerId>; this scan rolls them
    // back to the main queue so the new worker re-takes them.
    try {
      const { recovered } = await this.queue.recoverOrphans();
      if (recovered > 0) this.log.info({ recovered }, 'recovered orphaned jobs from previous worker(s)');
    } catch (err) {
      this.log.error({ err }, 'recoverOrphans failed — proceeding without recovery');
    }
    this.log.info('renderer ready; entering job loop');
    // Idle heartbeat — Tier-2 uptime check on Box C reads OBJECT
    // IDLETIME on this key to confirm the worker is alive even when
    // the queue is empty. Updated every 30s. The per-job heartbeat
    // (dm:archive:active:<wid>) only runs WHILE processing a job;
    // without this idle one, the uptime probe would alert any time
    // there were no jobs for >5 min.
    this.startIdleHeartbeat();
    // Concurrency: spawn N parallel job-processing loops. Each loop owns
    // its ArchiveQueue instance because queue completion tracks the exact
    // raw JSON moved into that loop's processing list.
    const loops: Promise<void>[] = [];
    for (let i = 0; i < this.config.maxConcurrentJobs; i++) {
      loops.push(this.runLoop(i));
    }
    loops.push(this.runDeleteLoop());
    await Promise.all(loops);
  }

  private idleHeartbeat?: NodeJS.Timeout;
  private startIdleHeartbeat(): void {
    const tick = (): void => {
      this.redis
        .set('dm:archive:worker-heartbeat', this.queue.workerId, 'EX', 600)
        .catch((err) => this.log.error({ err }, 'idle heartbeat failed'));
    };
    tick();
    this.idleHeartbeat = setInterval(tick, 30_000);
    this.idleHeartbeat.unref();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.log.info('shutdown requested; waiting for in-flight jobs');
    // Wait for in-flight jobs to finish before tearing down. Cap at the
    // render timeout + slack so we don't sit forever on a hung headless
    // browser. If a job blows past this, the BLMOVE-based processing
    // list keeps it recoverable: the next worker boots, runs
    // recoverOrphans, and re-queues whatever was in flight.
    const graceMs = this.config.playwrightRenderTimeoutMs + 10_000;
    await this.waitForLoopsIdle(graceMs);
    this.queue.stopHeartbeat();
    for (const queue of this.loopQueues) queue.stopHeartbeat();
    if (this.idleHeartbeat) clearInterval(this.idleHeartbeat);
    await this.renderer.shutdown();
    this.redis.disconnect();
    this.log.info('shutdown complete');
  }

  private async waitForLoopsIdle(maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (this.activeJobs > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private async runLoop(loopIndex: number): Promise<void> {
    const queue = new ArchiveQueue(this.redis, this.config.heartbeatIntervalMs);
    this.loopQueues.add(queue);
    try {
      while (!this.shuttingDown) {
        try {
          // BLMOVE with 5s timeout so we can check shuttingDown regularly.
          const job = await queue.takeJob(5);
          if (!job) continue;

          this.log.info(
            { jobId: job.jobId, url: job.url, attempt: job.attempts, loop: loopIndex, workerId: queue.workerId },
            'picked up job',
          );

          this.activeJobs += 1;
          try {
            await this.processJob(job, queue);
          } finally {
            this.activeJobs -= 1;
          }
        } catch (err) {
          this.log.error({ err }, 'unexpected error in worker loop');
          // Don't crash the loop; pause briefly and continue.
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
    } finally {
      queue.stopHeartbeat();
      this.loopQueues.delete(queue);
    }
  }

  private async processJob(job: ArchiveJob, queue: ArchiveQueue): Promise<void> {
    if (job.kind === 'youtube') {
      await this.processYoutubeJob(job, queue);
      return;
    }
    const startedAt = Date.now();
    void queue.audit(job.jobId, 'taken', { url: job.url, attempt: job.attempts });
    try {
      // Defence-in-depth SSRF check. The proxy already validates on
      // submission, but a future caller (admin requeue, internal job
      // injection, schema bypass) could feed us an unsafe URL — and
      // the worker is the thing with credentials and network access
      // to internal targets (Redis, Box C, Linode metadata). Reject
      // here before any fetch.
      try {
        await assertSafePublicHttpUrl(job.url);
      } catch (err) {
        const reason = err instanceof UnsafeUrlError ? err.message : String(err);
        this.log.warn({ jobId: job.jobId, url: job.url, reason }, 'rejecting unsafe url');
        await queue.complete({
          jobId: job.jobId,
          status: 'failed',
          error: reason,
          errorCategory: 'permanent',
          completedAt: Math.floor(Date.now() / 1000),
        });
        return;
      }

      // Step 1: render the live page first. Wayback is a fallback, not
      // the primary source: a user who archives a current bookmark
      // expects the page as it resolves now, not an older public
      // snapshot that may miss content.
      let plaintext: Buffer;
      let screenshot: Buffer | null = null;
      let source: 'wayback' | 'rendered';

      try {
        void queue.audit(job.jobId, 'render-start');
        const result = await this.renderer.render(job.url);
        plaintext = result.html;
        screenshot = result.screenshot;
        source = 'rendered';
        this.log.info(
          { jobId: job.jobId, bytes: plaintext.byteLength, screenshotBytes: screenshot?.byteLength ?? 0 },
          'rendered via playwright',
        );
        void queue.audit(job.jobId, 'render-end', {
          bytes: plaintext.byteLength,
          screenshotBytes: screenshot?.byteLength ?? 0,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(
          { jobId: job.jobId, url: job.url, error: message },
          'live render failed; trying Wayback fallback',
        );
        void queue.audit(job.jobId, 'render-failed-before-wayback', {
          error: message,
          category: categorize(err),
        });

        const waybackHit = await fetchWaybackIfFresh(job.url, this.config.waybackMaxAgeDays);
        if (!waybackHit) {
          void queue.audit(job.jobId, 'wayback-miss-after-render-failure');
          throw err;
        }

        plaintext = waybackHit.html;
        screenshot = null;
        source = 'wayback';
        this.log.info(
          { jobId: job.jobId, capturedAt: waybackHit.capturedAt },
          'using Wayback fallback snapshot after live render failed',
        );
        void queue.audit(job.jobId, 'wayback-fallback-hit', {
          bytes: plaintext.byteLength,
          capturedAt: waybackHit.capturedAt,
          renderError: message,
        });
      }

      // Step 2: for private tier, encrypt; otherwise pass through.
      let finalBlob: Buffer;
      if (job.tier === 'private') {
        if (!job.archiveKey) {
          throw new PermanentError(
            'missing_archive_key',
            'private tier job has no archiveKey',
          );
        }
        finalBlob = encryptBlob(plaintext, job.archiveKey);
        // Best-effort key wipe. V8 string pool may retain a copy but
        // we hold the reference only in this scope.
        zeroize(plaintext);
      } else {
        finalBlob = plaintext;
      }
      const archiveContentType = job.tier === 'private'
        ? 'application/octet-stream'
        : 'text/html';

      // Step 3: upload to primary. For public tier we ALSO upload the
      // viewport screenshot as a separate blob so the UI can render
      // a thumbnail without fetching + parsing the full archive HTML.
      // Private archives skip the screenshot — its bytes would leak
      // page content that the encrypted main archive otherwise hides.
      // Run uploads in parallel since they're both ~100KB-1MB and
      // there's no ordering dependency between them.
      const screenshotForUpload =
        screenshot && job.tier !== 'private' ? screenshot : null;
      const [uploadResult, screenshotUpload] = await Promise.all([
        this.blossom.upload(finalBlob, archiveContentType),
        screenshotForUpload
          ? this.blossom.upload(screenshotForUpload, 'image/jpeg').catch((err) => {
              // Non-fatal — log and continue with no thumbnail.
              this.log.warn({ jobId: job.jobId, err }, 'screenshot upload failed; archive proceeds without thumbnail');
              return null;
            })
          : Promise.resolve(null),
      ]);
      this.log.info(
        {
          jobId: job.jobId,
          hash: uploadResult.blobHash,
          size: uploadResult.size,
          thumbHash: screenshotUpload?.blobHash,
          thumbSize: screenshotUpload?.size,
        },
        'blob uploaded to primary',
      );
      void queue.audit(job.jobId, 'uploaded', {
        blobHash: uploadResult.blobHash,
        size: uploadResult.size,
        thumbHash: screenshotUpload?.blobHash,
      });

      // Step 3.5: post-upload verify. PUT /upload returning 200 doesn't
      // always mean the blob is retrievable — some Blossom backends
      // ack on accept, then fsync async; storage hiccups would leave
      // us with a done record pointing at a hash the user can't fetch.
      // HEAD round-trip catches that and forces a retry. Treat as
      // retryable: the same key + bytes will produce the same blobHash,
      // so the upload is idempotent.
      const verify = await this.blossom.verify(uploadResult.blobHash);
      if (!verify.ok) {
        void queue.audit(job.jobId, 'verify-failed', {
          blobHash: uploadResult.blobHash,
          status: verify.status,
        });
        throw new RenderError(
          'verify_failed',
          `post-upload HEAD returned ${verify.status} for ${uploadResult.blobHash}`,
          'retryable',
        );
      }
      // Intentionally NOT comparing verify.size against finalBlob.byteLength.
      // Our Blossom server (and several others in the wild) doesn't return
      // an accurate Content-Length on HEAD — observed 20 bytes consistently
      // for blobs that are actually tens-to-hundreds of KB, presumably a
      // sentinel response. A strict size check rejected every legitimate
      // upload. The 200 OK is enough confirmation that the hash resolves;
      // the upload itself already verified the bytes (Blossom indexes by
      // SHA-256 of the body, so a successful upload + reachable hash means
      // the right bytes are addressable).
      void queue.audit(job.jobId, 'verified', {
        blobHash: uploadResult.blobHash,
        reportedSize: verify.size,
      });

      // Step 4: fan out to the configured Blossom mirrors. The worker
      // owns the Blossom signing key, so BUD-04 mirror requests happen
      // here immediately after primary upload verification. Mirror
      // failures are recorded and sent to payment-proxy for operator
      // alerts, but they don't throw away a good primary archive.
      const mirrorTargets = await resolveMirrorTargets({
        primaryUrl: this.config.blossomPrimaryUrl,
        operatorUrls: this.config.blossomMirrorUrls,
        userUrls: job.mirrorUrls,
      });
      const mirrorUrls = mirrorTargets.urls;
      const mirrorResults = mirrorUrls.length > 0
        ? await this.blossom.mirror(uploadResult.blobHash, mirrorUrls, finalBlob, archiveContentType)
        : [];
      const allMirrorResults = [...mirrorTargets.rejected, ...mirrorResults];
      if (mirrorUrls.length > 0) {
        const ok = allMirrorResults.filter((r) => r.ok).length;
        const failed = allMirrorResults.length - ok;
        this.log.info(
          { jobId: job.jobId, hash: uploadResult.blobHash, ok, failed, mirrors: allMirrorResults },
          'blob mirror fanout complete',
        );
        void queue.audit(job.jobId, 'mirrored', {
          blobHash: uploadResult.blobHash,
          ok,
          failed,
          mirrors: allMirrorResults,
        });
      } else {
        this.log.warn({ jobId: job.jobId, hash: uploadResult.blobHash }, 'no Blossom mirror targets configured');
        void queue.audit(job.jobId, 'mirror-skipped', {
          blobHash: uploadResult.blobHash,
          reason: 'no mirror targets configured',
        });
      }

      // Step 5: notify payment-proxy, which records the archive and
      // emits any operational alert for partial mirror replication.
      await this.notifyPaymentProxy({
        jobId: job.jobId,
        status: 'ok',
        blobHash: uploadResult.blobHash,
        source,
        // Default to 'public' when the proxy enqueued without a tier
        // — the proxy-side schema is `tier?: 'public' | 'private'`,
        // and a missing tier means an old/legacy job (or a public
        // archive). The proxy's callback handler enforces the field
        // is present, so the explicit fallback is required.
        tier: job.tier ?? 'public',
        ownerPubkey: job.ownerPubkey,
        url: job.url,
        // Optional thumbnail blob hash. Public-tier archives upload a
        // viewport JPEG alongside the main HTML so the UI can render
        // a real preview instead of just a favicon. Private-tier
        // archives intentionally skip this — the screenshot bytes
        // would leak page content the encrypted main archive hides.
        thumbHash: screenshotUpload?.blobHash,
        thumbSize: screenshotUpload?.size,
        mirrors: allMirrorResults,
      });

      // Step 6: mark done in Redis + publish event.
      await queue.complete({
        jobId: job.jobId,
        status: 'ok',
        blobHash: uploadResult.blobHash,
        source,
        completedAt: Math.floor(Date.now() / 1000),
      });

      const durationMs = Date.now() - startedAt;
      this.log.info({ jobId: job.jobId, durationMs }, 'job complete');
      void queue.audit(job.jobId, 'completed', {
        blobHash: uploadResult.blobHash,
        durationMs,
      });
    } catch (err) {
      await this.handleError(job, err, queue);
    }
  }

  /**
   * YouTube archive branch. Runs yt-dlp to download the video at
   * ≤720p as MKV (VP9 + Opus, no transcode), encrypts client-side
   * with the user's archive key, uploads the encrypted blob to
   * Blossom, and reports back to payment-proxy with the resolved
   * title + channel so the UI can render "Title — Channel" instead
   * of a bare video id.
   *
   * Always private regardless of `job.tier` — the source URL is
   * still public on YouTube, but the downloaded MP4 stays in our
   * encrypted store, keyed only to the user.
   *
   * Dedup short-circuit: if another user has already archived this
   * video, the metadata blob in Redis lets us record the user's
   * new archive against the existing blob hash without re-running
   * yt-dlp. The refcount in payment-proxy handles eventual cleanup
   * when the last reference goes away.
   */
  private async processYoutubeJob(job: ArchiveJob, queue: ArchiveQueue): Promise<void> {
    const startedAt = Date.now();
    void queue.audit(job.jobId, 'taken', { url: job.url, kind: 'youtube', attempt: job.attempts });
    try {
      if (!job.videoId) {
        throw new PermanentError('missing_video_id', 'youtube job missing videoId');
      }
      if (!job.archiveKey) {
        throw new PermanentError('missing_archive_key', 'youtube job missing archiveKey');
      }

      // Dedup pivot: another user may have already archived the same
      // video. The proxy stamps `dm:archive-meta:yt:<videoId>` on the
      // first successful run; reuse that record so the user gets an
      // instant archive instead of a fresh ~3-minute yt-dlp pass.
      const dedupKey = `dm:archive-meta:yt:${job.videoId.toLowerCase()}`;
      const cached = await this.redis.get(dedupKey).catch(() => null);
      if (cached) {
        try {
          const meta = JSON.parse(cached) as {
            blobHash?: string; videoTitle?: string; videoChannel?: string; videoDurationSeconds?: number;
          };
          if (meta.blobHash) {
            this.log.info(
              { jobId: job.jobId, videoId: job.videoId, blobHash: meta.blobHash },
              'youtube archive dedup hit — skipping yt-dlp run',
            );
            void queue.audit(job.jobId, 'youtube-dedup-hit', { blobHash: meta.blobHash });
            await this.notifyPaymentProxy({
              jobId: job.jobId,
              status: 'ok',
              blobHash: meta.blobHash,
              source: 'rendered',
              tier: 'private',
              ownerPubkey: job.ownerPubkey,
              url: job.url,
              kind: 'youtube',
              videoId: job.videoId,
              videoTitle: meta.videoTitle,
              videoChannel: meta.videoChannel,
              videoDurationSeconds: meta.videoDurationSeconds,
              mirrors: [],
            });
            await queue.complete({
              jobId: job.jobId,
              status: 'ok',
              blobHash: meta.blobHash,
              source: 'rendered',
              completedAt: Math.floor(Date.now() / 1000),
            });
            return;
          }
        } catch { /* corrupt cache — fall through to a real download */ }
      }

      // Download + mux into MKV.
      void queue.audit(job.jobId, 'youtube-download-start');
      const result = await downloadYoutubeArchive(job.videoId, {
        info: (msg: unknown, obj?: unknown) => this.log.info(obj as object ?? {}, String(msg)),
        warn: (msg: unknown, obj?: unknown) => this.log.warn(obj as object ?? {}, String(msg)),
      });
      void queue.audit(job.jobId, 'youtube-download-end', {
        bytes: result.blob.byteLength,
        title: result.title,
        channel: result.channel,
        durationSeconds: result.durationSeconds,
      });

      // Encrypt — YouTube archives are always private.
      const encrypted = encryptBlob(result.blob, job.archiveKey);
      zeroize(result.blob);

      const uploadResult = await this.blossom.upload(encrypted, 'application/octet-stream');
      this.log.info(
        { jobId: job.jobId, videoId: job.videoId, blobHash: uploadResult.blobHash, bytes: encrypted.byteLength },
        'youtube archive uploaded',
      );

      await this.notifyPaymentProxy({
        jobId: job.jobId,
        status: 'ok',
        blobHash: uploadResult.blobHash,
        source: 'rendered',
        tier: 'private',
        ownerPubkey: job.ownerPubkey,
        url: job.url,
        kind: 'youtube',
        videoId: job.videoId,
        videoTitle: result.title,
        videoChannel: result.channel,
        videoDurationSeconds: result.durationSeconds,
        mirrors: [],
      });

      await queue.complete({
        jobId: job.jobId,
        status: 'ok',
        blobHash: uploadResult.blobHash,
        source: 'rendered',
        completedAt: Math.floor(Date.now() / 1000),
      });

      const durationMs = Date.now() - startedAt;
      this.log.info({ jobId: job.jobId, durationMs }, 'youtube job complete');
      void queue.audit(job.jobId, 'completed', {
        blobHash: uploadResult.blobHash,
        durationMs,
        videoId: job.videoId,
      });
    } catch (err) {
      await this.handleError(job, err, queue);
    }
  }

  private async runDeleteLoop(): Promise<void> {
    while (!this.shuttingDown) {
      try {
        const row = await this.redis.blpop(KEYS.deleteQueue, 5);
        if (!row) continue;
        const raw = row[1];
        let job: ArchiveDeleteJob;
        try {
          job = JSON.parse(raw) as ArchiveDeleteJob;
        } catch (err) {
          this.log.warn({ err }, 'dropping malformed archive delete job');
          continue;
        }
        this.activeJobs += 1;
        try {
          await this.processDeleteJob(job);
        } finally {
          this.activeJobs -= 1;
        }
      } catch (err) {
        this.log.error({ err }, 'unexpected error in archive delete loop');
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }

  private async processDeleteJob(job: ArchiveDeleteJob): Promise<void> {
    const attempt = job.attempt ?? 0;
    if (!/^[0-9a-f]{64}$/.test(job.blobHash)) {
      this.log.warn({ job }, 'dropping archive delete job with invalid blob hash');
      return;
    }

    const targets = await resolveMirrorTargets({
      primaryUrl: this.config.blossomPrimaryUrl,
      operatorUrls: [],
      userUrls: job.mirrorUrls,
    });
    const mirrorUrls = targets.urls;
    if (mirrorUrls.length === 0) {
      this.log.info({ blobHash: job.blobHash, rejected: targets.rejected }, 'archive delete has no valid mirrors');
      return;
    }

    const results = await Promise.all(
      mirrorUrls.map((url) => this.blossom.deleteFrom(url, job.blobHash)),
    );
    const failed = results.filter((r) => !r.ok);
    this.log.info(
      {
        blobHash: job.blobHash,
        reason: job.reason,
        ok: results.length - failed.length,
        failed: failed.length,
        rejected: targets.rejected,
      },
      'archive mirror delete fanout complete',
    );
    if (failed.length === 0) return;

    if (attempt >= MAX_ATTEMPTS - 1) {
      this.log.warn(
        { blobHash: job.blobHash, failed, attempt },
        'archive mirror delete exhausted retries',
      );
      return;
    }

    const retry: ArchiveDeleteJob = {
      ...job,
      mirrorUrls: failed.map((r) => r.url),
      attempt: attempt + 1,
    };
    await this.redis.rpush(KEYS.deleteQueue, JSON.stringify(retry));
  }

  private async handleError(job: ArchiveJob, err: unknown, queue: ArchiveQueue): Promise<void> {
    const category = categorize(err);
    const message = err instanceof Error ? err.message : String(err);
    this.log.warn(
      { jobId: job.jobId, attempt: job.attempts, category, error: message },
      'job failed',
    );
    void queue.audit(job.jobId, 'attempt-failed', {
      attempt: job.attempts,
      category,
      error: message,
    });

    const shouldRetry = category === 'retryable' && job.attempts < MAX_ATTEMPTS - 1;

    if (shouldRetry) {
      this.log.info(
        { jobId: job.jobId, nextAttempt: job.attempts + 1 },
        'requeueing retry at back of archive queue',
      );
      void queue.audit(job.jobId, 'retry-queued', { nextAttempt: job.attempts + 1 });
      await queue.requeue(job);
      return;
    }

    // Final failure: mark done, notify payment-proxy to refund.
    const record: DoneRecord = {
      jobId: job.jobId,
      status: 'failed',
      error: message,
      errorCategory: category,
      completedAt: Math.floor(Date.now() / 1000),
    };
    await queue.complete(record);
    await this.notifyPaymentProxy({
      jobId: job.jobId,
      status: 'failed',
      error: message,
      errorCategory: category,
      ownerPubkey: job.ownerPubkey,
      paymentHash: job.paymentHash,
    }).catch((e) => {
      this.log.error({ err: e }, 'payment-proxy notification failed');
    });
  }

  private async notifyPaymentProxy(payload: Record<string, unknown>): Promise<void> {
    // Sign the request so the proxy can prove it came from us AND that
    // the payload wasn't tampered with mid-flight. HMAC over
    // `${timestamp}|${rawBody}` keyed by the shared secret. The
    // timestamp is sent in a header and re-checked on the server inside
    // a 5-minute window so a leaked header can't be replayed.
    const ts = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify(payload);
    const sig = createHmac('sha256', this.config.workerCallbackSecret)
      .update(ts)
      .update('|')
      .update(body)
      .digest('hex');
    const res = await fetch(`${this.config.paymentProxyUrl}/archive/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-Timestamp': ts,
        'X-Worker-Signature': sig,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`payment-proxy callback failed: ${res.status}`);
    }
  }
}

class PermanentError extends Error {
  readonly category = 'permanent' as const;
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

function categorize(err: unknown): 'retryable' | 'permanent' {
  if (err instanceof PermanentError) return 'permanent';
  if (err instanceof RenderError) return err.category;

  const msg = err instanceof Error ? err.message : String(err);
  // Heuristics: network-ish errors are retryable.
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|503|502|504|fetch failed|timeout/i.test(msg)) {
    return 'retryable';
  }
  // Default: retryable. We'd rather spend one extra Playwright launch
  // than permanently fail a user's 500-sat archive over an unknown error.
  return 'retryable';
}

function decodeNsec(nsec: string): string {
  // Decode a bech32 nsec to hex. nip19 is imported statically at the top
  // of the file so this works under ESM (module was previously using
  // `require()` which broke at runtime on Node 20).
  const decoded = nip19.decode(nsec);
  if (decoded.type !== 'nsec') throw new Error(`expected nsec, got ${decoded.type}`);
  return Buffer.from(decoded.data as Uint8Array).toString('hex');
}
