import Redis from 'ioredis';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { getPublicKey, nip19 } from 'nostr-tools';
import {
  ArchiveQueue,
  ACTIVE_HEARTBEAT_TTL_SECONDS,
  KEYS,
  MAX_ATTEMPTS,
  type ArchiveDeleteJob,
  type ArchiveFileRecord,
  type ArchiveJob,
  type DoneRecord,
} from './queue.js';
import { fetchWaybackIfFresh } from './wayback.js';
import { PageRenderer, RenderError } from './renderer.js';
import { encryptBlob, zeroize } from './crypto.js';
import { BlossomClient } from './blossom.js';
import { assertSafePublicHttpUrl, resolveSafePublicHttpUrl, UnsafeUrlError } from './safe-url.js';
import { resolveMirrorTargets } from './mirror-targets.js';
import { downloadVideoArchive, type MediaSidecar, type VideoArchiveResult } from './youtube.js';
import {
  isLikelyAudioUrl,
  isLikelyImageUrl,
  isLikelyStreamingManifestUrl,
  isLikelyVideoUrl,
  shouldAttemptDirectFileArchive,
  tryDownloadDirectFileArchive,
  type DirectFileArchive,
} from './direct-file.js';
import { detectScholarlyFullTextPdf } from './scholarly.js';
import { tryResolvePodcastEpisodeArchive } from './podcast.js';

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
  archiveAuditIntervalMs: number;
  archiveAuditStaleAfterSeconds: number;
  archiveAuditMaxJobsPerPass: number;
  archiveAuditMaxRuntimeMs: number;
  logLevel: string;
}

interface ArchiveJobMetadata {
  jobId: string;
  paymentHash: string;
  ownerPubkey: string;
  url: string;
  tier: 'private' | 'public';
  mirrorUrls?: string[];
  enqueuedAt: number;
  bookmarkSavedAt?: number;
  kind?: ArchiveJob['kind'];
  videoId?: string;
  videoContentKey?: string;
  amountSats?: number;
}

interface ArchiveAuditSummary {
  at: number;
  scanned: number;
  completed: number;
  live: number;
  failed: number;
  stale: number;
  pending: number;
  renotified: number;
  renotifyDeferred: number;
  requeued: number;
  requeueDeferred: number;
  rescued: number;
  rescueDeferred: number;
  waybackMiss: number;
  markedLostFailed: number;
  skippedNonRescuable: number;
  errors: number;
  truncated: boolean;
  runtimeMs?: number;
}

const ARCHIVE_JOB_PREFIX = 'dm:archive-job:';
const ARCHIVE_COMPLETED_PREFIX = 'dm:archive-completed:';
const ARCHIVE_AUDIT_SUMMARY_KEY = 'dm:archive-audit:last';
const ARCHIVE_AUDIT_CURSOR_KEY = 'dm:archive-audit:cursor';
const ARCHIVE_AUDIT_RENOTIFY_PREFIX = 'dm:archive-audit:renotify:';
const ARCHIVE_AUDIT_FAILURE_RENOTIFY_PREFIX = 'dm:archive-audit:renotify-failure:';
const ARCHIVE_AUDIT_REQUEUE_PREFIX = 'dm:archive-audit:requeue:';
const ARCHIVE_AUDIT_RESCUE_PREFIX = 'dm:archive-audit:rescue:';
const ARCHIVE_AUDIT_LOST_FAILED_PREFIX = 'dm:archive-audit:lost-failed:';
const MAX_BROWSER_CAPTURE_BYTES = 5 * 1024 * 1024;

export class Worker {
  private redis: Redis;
  private queue: ArchiveQueue;
  private renderer: PageRenderer;
  private blossom: BlossomClient;
  private log: pino.Logger;
  private shuttingDown = false;
  private activeJobs = 0;
  private readonly loopQueues = new Set<ArchiveQueue>();
  private archiveAuditKickoffTimer?: NodeJS.Timeout;
  private archiveAuditTimer?: NodeJS.Timeout;
  private orphanRecoveryTimer?: NodeJS.Timeout;
  private archiveAuditRunning = false;

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
    // dm:archive:processing:<workerId>; this scan rolls back lists
    // whose matching active heartbeat is gone. A second pass runs
    // after the active TTL so a just-crashed worker is recovered
    // without duplicating a live overlapping worker.
    await this.recoverOrphans('startup');
    this.schedulePostHeartbeatOrphanRecovery();
    this.log.info('renderer ready; entering job loop');
    // Idle heartbeat — Tier-2 uptime check on Box C reads OBJECT
    // IDLETIME on this key to confirm the worker is alive even when
    // the queue is empty. Updated every 30s. The per-job heartbeat
    // (dm:archive:active:<wid>) only runs WHILE processing a job;
    // without this idle one, the uptime probe would alert any time
    // there were no jobs for >5 min.
    this.startIdleHeartbeat();
    this.startArchiveAuditLoop();
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
  private async recoverOrphans(reason: string): Promise<void> {
    try {
      const { recovered } = await this.queue.recoverOrphans();
      if (recovered > 0) this.log.info({ recovered, reason }, 'recovered orphaned jobs from previous worker(s)');
    } catch (err) {
      this.log.error({ err, reason }, 'recoverOrphans failed — proceeding without recovery');
    }
  }

  private schedulePostHeartbeatOrphanRecovery(): void {
    const delayMs = (ACTIVE_HEARTBEAT_TTL_SECONDS + 5) * 1_000;
    this.orphanRecoveryTimer = setTimeout(() => {
      if (this.shuttingDown) return;
      void this.recoverOrphans('post-active-heartbeat-expiry');
    }, delayMs);
    this.orphanRecoveryTimer.unref();
  }

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
    if (this.archiveAuditKickoffTimer) clearTimeout(this.archiveAuditKickoffTimer);
    if (this.archiveAuditTimer) clearInterval(this.archiveAuditTimer);
    if (this.orphanRecoveryTimer) clearTimeout(this.orphanRecoveryTimer);
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
    // BLMOVE is a blocking Redis command. Keep it on a dedicated
    // connection so control-plane work such as audits and heartbeats
    // cannot queue behind empty-queue waits.
    const queueRedis = this.redis.duplicate();
    const queue = new ArchiveQueue(queueRedis, this.config.heartbeatIntervalMs);
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
      queueRedis.disconnect();
    }
  }

  private async processJob(job: ArchiveJob, queue: ArchiveQueue): Promise<void> {
    if (job.kind === 'youtube' || job.kind === 'video' || job.kind === 'media') {
      await this.processVideoJob(job, queue);
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

      // Step 1: render the live page first. PDF/audio direct-file URLs are a
      // first-class archive type because Chromium treats many of them as
      // downloads, not pages, and SingleFile can only snapshot HTML.
      // Wayback is a fallback for HTML pages, not the primary source:
      // a user who archives a current bookmark expects the page as it
      // resolves now, not an older public snapshot that may miss content.
      let plaintext: Buffer | null = null;
      let screenshot: Buffer | null = null;
      let source: 'wayback' | 'rendered' | 'file' = 'rendered';
      let originalContentType = 'text/html';
      let archiveKind: 'webpage' | 'file' = 'webpage';
      let fileName: string | undefined;
      let renderError: unknown = null;
      let scholarlyPdfUrl: string | null = null;

      const capturedHtml = decodeCapturedHtml(job);
      if (capturedHtml) {
        if (job.tier !== 'private') {
          throw new PermanentError(
            'invalid_browser_capture_tier',
            'browser-captured archives must be private',
          );
        }
        plaintext = capturedHtml;
        source = 'rendered';
        originalContentType = job.capturedContentType || 'text/html; charset=utf-8';
        archiveKind = 'webpage';
        const scholarlyPdf = detectScholarlyFullTextPdf(job.url, plaintext);
        scholarlyPdfUrl = scholarlyPdf?.pdfUrl ?? null;
        this.log.info(
          {
            jobId: job.jobId,
            bytes: plaintext.byteLength,
            title: job.capturedTitle,
            capturedAt: job.capturedAt,
            scholarlyPdf: scholarlyPdfUrl,
          },
          'loaded browser-captured archive HTML',
        );
        void queue.audit(job.jobId, 'browser-capture-loaded', {
          bytes: plaintext.byteLength,
          title: job.capturedTitle,
          capturedAt: job.capturedAt,
          scholarlyPdf: scholarlyPdfUrl,
        });
      }

      const directFile = plaintext ? null : await tryDownloadDirectFileArchive(job.url).catch((err) => {
        if (shouldAttemptDirectFileArchive(job.url, err)) throw err;
        this.log.warn({ jobId: job.jobId, err }, 'direct file probe failed; falling back to HTML render');
        return null;
      });
      if (directFile) {
        plaintext = directFile.bytes;
        source = 'file';
        originalContentType = directFile.contentType;
        archiveKind = 'file';
        fileName = directFile.fileName;
        this.log.info(
          { jobId: job.jobId, bytes: plaintext.byteLength, fileName },
          'downloaded direct file archive',
        );
        void queue.audit(job.jobId, 'direct-file-downloaded', {
          bytes: plaintext.byteLength,
          contentType: originalContentType,
          fileName,
        });
      } else if (!plaintext) {
        try {
          void queue.audit(job.jobId, 'render-start');
          const result = await this.renderer.render(job.url);
          plaintext = result.html;
          screenshot = result.screenshot;
          source = 'rendered';
          const scholarlyPdf = detectScholarlyFullTextPdf(job.url, plaintext);
          scholarlyPdfUrl = scholarlyPdf?.pdfUrl ?? null;
          this.log.info(
            {
              jobId: job.jobId,
              bytes: plaintext.byteLength,
              screenshotBytes: screenshot?.byteLength ?? 0,
              scholarlyPdf: scholarlyPdfUrl,
            },
            'rendered via playwright',
          );
          void queue.audit(job.jobId, 'render-end', {
            bytes: plaintext.byteLength,
            screenshotBytes: screenshot?.byteLength ?? 0,
            scholarlyPdf: scholarlyPdfUrl,
          });
        } catch (err) {
          if (shouldAttemptDirectFileArchive(job.url, err)) {
            const direct = await tryDownloadDirectFileArchive(job.url, { force: true });
            if (direct) {
              plaintext = direct.bytes;
              source = 'file';
              originalContentType = direct.contentType;
              archiveKind = 'file';
              fileName = direct.fileName;
              this.log.info(
                { jobId: job.jobId, bytes: plaintext.byteLength, fileName },
                'downloaded direct file archive after render fallback',
              );
              void queue.audit(job.jobId, 'direct-file-downloaded-after-render-failure', {
                bytes: plaintext.byteLength,
                contentType: originalContentType,
                fileName,
              });
            } else {
              renderError = err;
            }
          } else {
            renderError = err;
          }
        }
      }

      if (renderError) {
        const message = renderError instanceof Error ? renderError.message : String(renderError);
        this.log.warn(
          { jobId: job.jobId, url: job.url, error: message },
          'live render failed; trying Wayback fallback',
        );
        void queue.audit(job.jobId, 'render-failed-before-wayback', {
          error: message,
          category: categorize(renderError),
        });

        const waybackHit = await fetchWaybackIfFresh(job.url, this.config.waybackMaxAgeDays);
        if (!waybackHit) {
          void queue.audit(job.jobId, 'wayback-miss-after-render-failure');
          throw renderError;
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

      if (!plaintext) {
        throw new RenderError('empty_output', 'archive capture produced no bytes', 'retryable');
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
        : safePublicArchiveContentType(originalContentType);

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
      const files: ArchiveFileRecord[] = [{
        role: primaryArchiveFileRole(archiveKind, originalContentType),
        blobHash: uploadResult.blobHash,
        url: job.url,
        source,
        contentType: originalContentType,
        fileName,
        thumbHash: screenshotUpload?.blobHash,
        mirrors: allMirrorResults,
      }];
      if (archiveKind === 'webpage' && scholarlyPdfUrl) {
        const pdfFile = await this.tryArchiveScholarlyPdf({
          job,
          pdfUrl: scholarlyPdfUrl,
          mirrorUrls,
          rejectedMirrors: mirrorTargets.rejected,
          queue,
        });
        if (pdfFile) files.push(pdfFile);
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
        bookmarkSavedAt: job.bookmarkSavedAt,
        kind: archiveKind,
        contentType: originalContentType,
        fileName,
        files,
      });

      // Step 6: mark done in Redis + publish event.
      await queue.complete({
        jobId: job.jobId,
        status: 'ok',
        blobHash: uploadResult.blobHash,
        source,
        completedAt: Math.floor(Date.now() / 1000),
        bookmarkSavedAt: job.bookmarkSavedAt,
        contentType: originalContentType,
        fileName,
        files,
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

  private startArchiveAuditLoop(): void {
    if (this.config.archiveAuditIntervalMs <= 0) return;
    this.log.info(
      {
        intervalMs: this.config.archiveAuditIntervalMs,
        maxJobs: this.config.archiveAuditMaxJobsPerPass,
        maxRuntimeMs: this.config.archiveAuditMaxRuntimeMs,
      },
      'archive audit loop scheduled',
    );
    const run = (): void => {
      if (this.shuttingDown || this.archiveAuditRunning) return;
      this.archiveAuditRunning = true;
      void this.runArchiveAuditPass()
        .then((summary) => {
          this.log.info(summary, 'archive audit pass complete');
        })
        .catch((err) => {
          this.log.error({ err }, 'archive audit pass failed');
        })
        .finally(() => {
          this.archiveAuditRunning = false;
        });
    };
    this.archiveAuditKickoffTimer = setTimeout(run, 30_000);
    this.archiveAuditKickoffTimer.unref();
    this.archiveAuditTimer = setInterval(run, this.config.archiveAuditIntervalMs);
    this.archiveAuditTimer.unref();
  }

  private async runArchiveAuditPass(): Promise<ArchiveAuditSummary> {
    const summary: ArchiveAuditSummary = {
      at: Math.floor(Date.now() / 1000),
      scanned: 0,
      completed: 0,
      live: 0,
      failed: 0,
      stale: 0,
      pending: 0,
      renotified: 0,
      renotifyDeferred: 0,
      requeued: 0,
      requeueDeferred: 0,
      rescued: 0,
      rescueDeferred: 0,
      waybackMiss: 0,
      markedLostFailed: 0,
      skippedNonRescuable: 0,
      errors: 0,
      truncated: false,
    };
    const startedAtMs = Date.now();
    const deadlineMs = startedAtMs + this.config.archiveAuditMaxRuntimeMs;
    await this.writeArchiveAuditSummary(summary);
    this.log.info(summary, 'archive audit pass started');

    const liveStateDeadlineMs = Math.min(
      deadlineMs,
      startedAtMs + Math.min(Math.max(1_000, Math.floor(this.config.archiveAuditMaxRuntimeMs / 4)), 10_000),
    );
    const liveState = await this.collectLiveArchiveJobIds(liveStateDeadlineMs);
    if (liveState.truncated) summary.truncated = true;
    const liveJobIds = liveState.ids;
    const liveStateReliable = !liveState.truncated;
    if (Date.now() >= deadlineMs) {
      summary.truncated = true;
      summary.runtimeMs = Date.now() - startedAtMs;
      await this.writeArchiveAuditSummary(summary);
      return summary;
    }
    let cursor = await this.readArchiveAuditCursor();
    let resumeCursor = cursor;

    do {
      if (Date.now() >= deadlineMs) {
        summary.truncated = true;
        resumeCursor = cursor;
        break;
      }
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${ARCHIVE_JOB_PREFIX}*`,
        'COUNT',
        500,
      );
      cursor = next;
      resumeCursor = cursor;
      if (keys.length === 0) continue;
      const remainingBudget = Math.max(0, this.config.archiveAuditMaxJobsPerPass - summary.scanned);
      if (remainingBudget === 0) {
        summary.truncated = true;
        break;
      }
      const batchKeys = keys.slice(0, remainingBudget);
      if (batchKeys.length < keys.length) {
        summary.truncated = true;
        resumeCursor = cursor;
        cursor = '0';
      }
      const values = await this.redis.mget(...batchKeys);
      const metas: ArchiveJobMetadata[] = [];
      for (const value of values) {
        const meta = parseArchiveJobMetadata(value ?? null);
        if (!meta) continue;
        summary.scanned++;
        metas.push(meta);
      }
      if (metas.length === 0) continue;

      const statusPipeline = this.redis.pipeline();
      for (const meta of metas) {
        statusPipeline.exists(`${ARCHIVE_COMPLETED_PREFIX}${meta.jobId}`);
        statusPipeline.get(KEYS.done(meta.jobId));
      }
      const statusResults = await statusPipeline.exec();
      if (!statusResults) {
        summary.errors += metas.length;
        continue;
      }

      const rows: Array<{ meta: ArchiveJobMetadata; done: DoneRecord | null }> = [];
      const blobCheckRows: Array<{ meta: ArchiveJobMetadata; done: DoneRecord }> = [];
      for (let i = 0; i < metas.length; i++) {
        if (Date.now() >= deadlineMs) {
          summary.truncated = true;
          cursor = '0';
          break;
        }
        const meta = metas[i];
        if (!meta) continue;
        const completedResult = statusResults[i * 2];
        const doneResult = statusResults[i * 2 + 1];

        try {
          if (completedResult?.[0] || doneResult?.[0]) {
            throw completedResult?.[0] ?? doneResult?.[0];
          }
          if (Number(completedResult?.[1] ?? 0) > 0) {
            summary.completed++;
            continue;
          }
          if (liveJobIds.has(meta.jobId)) {
            summary.live++;
            continue;
          }
          const done = parseDoneRecord(typeof doneResult?.[1] === 'string' ? doneResult[1] : null);
          if (done?.status === 'ok') {
            rows.push({ meta, done });
            if (done.blobHash) blobCheckRows.push({ meta, done });
            continue;
          }
          rows.push({ meta, done });
        } catch (err) {
          summary.errors++;
          this.log.warn({ err, jobId: meta.jobId, url: meta.url }, 'archive audit item failed');
        }
      }
      const recordedJobIds = new Set<string>();
      const blobCheckErrorIds = new Set<string>();
      if (blobCheckRows.length > 0) {
        const blobPipeline = this.redis.pipeline();
        for (const row of blobCheckRows) {
          blobPipeline.hexists(`dm:archives:${row.meta.ownerPubkey}`, row.done.blobHash!);
        }
        const blobResults = await blobPipeline.exec();
        if (!blobResults) {
          summary.errors += blobCheckRows.length;
          for (const row of blobCheckRows) blobCheckErrorIds.add(row.meta.jobId);
        } else {
          for (let i = 0; i < blobCheckRows.length; i++) {
            const row = blobCheckRows[i];
            if (!row) continue;
            const result = blobResults[i];
            if (result?.[0]) {
              summary.errors++;
              blobCheckErrorIds.add(row.meta.jobId);
            } else if (Number(result?.[1] ?? 0) > 0) {
              recordedJobIds.add(row.meta.jobId);
            }
          }
        }
      }
      if (recordedJobIds.size > 0) {
        const markerPipeline = this.redis.pipeline();
        for (const jobId of recordedJobIds) {
          markerPipeline.set(
            `${ARCHIVE_COMPLETED_PREFIX}${jobId}`,
            '1',
            'EX',
            60 * 60 * 24 * 30,
            'NX',
          );
        }
        await markerPipeline.exec().catch(() => undefined);
      }

      for (const { meta, done } of rows) {
        if (Date.now() >= deadlineMs) {
          summary.truncated = true;
          cursor = '0';
          break;
        }
        if (done?.status === 'ok') {
          if (recordedJobIds.has(meta.jobId)) {
            summary.completed++;
          } else if (!blobCheckErrorIds.has(meta.jobId)) {
            summary.renotifyDeferred++;
          }
          continue;
        }
        if (done?.status === 'failed') {
          summary.failed++;
          if (done.callbackPending) {
            const notified = await this.renotifyArchiveFailure(meta, done);
            if (notified) summary.renotified++;
            else summary.renotifyDeferred++;
            continue;
          }
          if (!isWaybackRescuable(meta)) {
            summary.skippedNonRescuable++;
          } else {
            summary.rescueDeferred++;
          }
          continue;
        }

        const ageSeconds = summary.at - meta.enqueuedAt;
        if (ageSeconds < this.config.archiveAuditStaleAfterSeconds) {
          summary.pending++;
          continue;
        }

        summary.stale++;
        if (liveStateReliable && isMetadataReplayableArchive(meta)) {
          const requeued = await this.requeueLostArchiveJob(meta, 'stale-without-live-job');
          if (requeued === 'requeued') {
            summary.requeued++;
          } else if (requeued === 'claimed') {
            summary.requeueDeferred++;
          } else if (requeued === 'error') {
            summary.errors++;
          }
        } else if (isWaybackRescuable(meta)) {
          summary.rescueDeferred++;
        } else {
          summary.skippedNonRescuable++;
        }
      }
    } while (cursor !== '0');

    summary.runtimeMs = Date.now() - startedAtMs;
    await this.writeArchiveAuditCursor(summary.truncated ? resumeCursor : '0');
    await this.writeArchiveAuditSummary(summary);
    return summary;
  }

  private async readArchiveAuditCursor(): Promise<string> {
    const raw = await this.redis.get(ARCHIVE_AUDIT_CURSOR_KEY).catch(() => null);
    return raw && /^\d+$/.test(raw) ? raw : '0';
  }

  private async writeArchiveAuditCursor(cursor: string): Promise<void> {
    if (cursor && cursor !== '0') {
      await this.redis.set(ARCHIVE_AUDIT_CURSOR_KEY, cursor, 'EX', 24 * 60 * 60)
        .catch((err) => this.log.warn({ err, cursor }, 'archive audit cursor write failed'));
      return;
    }
    await this.redis.del(ARCHIVE_AUDIT_CURSOR_KEY)
      .catch((err) => this.log.warn({ err }, 'archive audit cursor clear failed'));
  }

  private async writeArchiveAuditSummary(summary: ArchiveAuditSummary): Promise<void> {
    await this.redis.set(ARCHIVE_AUDIT_SUMMARY_KEY, JSON.stringify(summary), 'EX', 24 * 60 * 60)
      .catch((err) => this.log.warn({ err }, 'archive audit summary write failed'));
  }

  private async collectLiveArchiveJobIds(deadlineMs: number): Promise<{ ids: Set<string>; truncated: boolean }> {
    const ids = new Set<string>();
    const maxIds = Math.max(1, this.config.archiveAuditMaxJobsPerPass);
    let truncated = false;
    const budgetExhausted = (): boolean => {
      if (Date.now() >= deadlineMs) {
        truncated = true;
        return true;
      }
      if (ids.size >= maxIds) {
        truncated = true;
        return true;
      }
      return false;
    };
    const addRaw = (raw: string | null): void => {
      const job = parseArchiveJob(raw);
      if (job?.jobId) ids.add(job.jobId);
    };

    const queued = await this.redis.lrange(KEYS.queue, 0, maxIds - 1).catch(() => []);
    for (const raw of queued) {
      if (budgetExhausted()) break;
      addRaw(raw);
    }
    if (budgetExhausted()) return { ids, truncated };

    let cursor = '0';
    do {
      if (budgetExhausted()) break;
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'dm:archive:processing:*', 'COUNT', 50);
      cursor = next;
      for (const key of keys) {
        if (budgetExhausted()) break;
        const remaining = Math.max(0, maxIds - ids.size);
        if (remaining === 0) break;
        const items = await this.redis.lrange(key, 0, remaining - 1).catch(() => []);
        for (const raw of items) {
          if (budgetExhausted()) break;
          addRaw(raw);
        }
      }
    } while (cursor !== '0');
    if (budgetExhausted()) return { ids, truncated };

    cursor = '0';
    do {
      if (budgetExhausted()) break;
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'dm:archive:active:*', 'COUNT', 50);
      cursor = next;
      if (keys.length === 0) continue;
      const remaining = Math.max(0, maxIds - ids.size);
      if (remaining === 0) break;
      const values = await this.redis.mget(...keys.slice(0, remaining)).catch(() => []);
      for (const raw of values) {
        if (budgetExhausted()) break;
        addRaw(raw ?? null);
      }
    } while (cursor !== '0');

    return { ids, truncated };
  }

  private async requeueLostArchiveJob(
    meta: ArchiveJobMetadata,
    reason: string,
  ): Promise<'requeued' | 'claimed' | 'skipped' | 'error'> {
    if (!isMetadataReplayableArchive(meta)) return 'skipped';
    const claim = await this.redis.set(
      `${ARCHIVE_AUDIT_REQUEUE_PREFIX}${meta.jobId}`,
      '1',
      'EX',
      60 * 60,
      'NX',
    );
    if (claim !== 'OK') return 'claimed';

    const job: ArchiveJob = {
      jobId: meta.jobId,
      paymentHash: meta.paymentHash,
      ownerPubkey: meta.ownerPubkey,
      url: meta.url,
      tier: 'public',
      archiveKey: null,
      mirrorUrls: meta.mirrorUrls,
      attempts: 0,
      enqueuedAt: Math.floor(Date.now() / 1000),
      bookmarkSavedAt: meta.bookmarkSavedAt,
      kind: meta.kind ?? 'webpage',
      videoId: meta.videoId,
      videoContentKey: meta.videoContentKey,
    };

    try {
      await this.redis.rpush(KEYS.queue, JSON.stringify(job));
      void this.queue.audit(meta.jobId, 'lost-job-requeued', { reason, source: 'metadata' });
      this.log.warn({ jobId: meta.jobId, url: meta.url, reason }, 'requeued stale archive job from metadata');
      return 'requeued';
    } catch (err) {
      this.log.warn({ err, jobId: meta.jobId, url: meta.url }, 'archive audit requeue failed');
      return 'error';
    }
  }

  private async renotifyArchiveSuccess(meta: ArchiveJobMetadata, done: DoneRecord): Promise<boolean> {
    if (!done.blobHash) return false;
    const claim = await this.redis.set(
      `${ARCHIVE_AUDIT_RENOTIFY_PREFIX}${meta.jobId}`,
      '1',
      'EX',
      60 * 60,
      'NX',
    );
    if (claim !== 'OK') return true;
    const primaryFile = archivePrimaryFile(done);
    try {
      await this.notifyPaymentProxy({
        jobId: meta.jobId,
        status: 'ok',
        blobHash: done.blobHash,
        source: done.source ?? 'rendered',
        tier: meta.tier,
        ownerPubkey: meta.ownerPubkey,
        url: meta.url,
        mirrors: primaryFile?.mirrors ?? [],
        bookmarkSavedAt: done.bookmarkSavedAt ?? meta.bookmarkSavedAt,
        kind: archiveKindForDone(meta, done),
        contentType: done.contentType,
        fileName: done.fileName,
        videoId: meta.videoId,
        videoContentKey: meta.videoContentKey,
        videoTitle: done.videoTitle,
        videoChannel: done.videoChannel,
        videoDurationSeconds: done.videoDurationSeconds,
        files: done.files,
      });
      void this.queue.audit(meta.jobId, 'success-renotified');
      return true;
    } catch (err) {
      this.log.warn({ err, jobId: meta.jobId }, 'archive audit success re-notify failed');
      return false;
    }
  }

  private async renotifyArchiveFailure(meta: ArchiveJobMetadata, done: DoneRecord): Promise<boolean> {
    const claim = await this.redis.set(
      `${ARCHIVE_AUDIT_FAILURE_RENOTIFY_PREFIX}${meta.jobId}`,
      '1',
      'EX',
      10 * 60,
      'NX',
    );
    if (claim !== 'OK') return false;
    try {
      await this.notifyPaymentProxy({
        jobId: meta.jobId,
        status: 'failed',
        error: done.error ?? 'archive failed',
        errorCategory: done.errorCategory ?? 'permanent',
        ownerPubkey: meta.ownerPubkey,
        paymentHash: meta.paymentHash,
        url: meta.url,
        tier: meta.tier,
        kind: meta.kind ?? 'webpage',
        videoId: meta.videoId,
        videoContentKey: meta.videoContentKey,
        bookmarkSavedAt: done.bookmarkSavedAt ?? meta.bookmarkSavedAt,
      });
      await this.redis.set(
        KEYS.done(meta.jobId),
        JSON.stringify({ ...done, callbackPending: false }),
        'EX',
        86_400,
      );
      await this.redis.del(`${ARCHIVE_AUDIT_FAILURE_RENOTIFY_PREFIX}${meta.jobId}`).catch(() => undefined);
      void this.queue.audit(meta.jobId, 'failure-renotified');
      return true;
    } catch (err) {
      this.log.warn({ err, jobId: meta.jobId }, 'archive audit failure re-notify failed');
      return false;
    }
  }

  private async tryWaybackRescue(
    meta: ArchiveJobMetadata,
    reason: string,
    sourceState: 'failed' | 'stale',
  ): Promise<'rescued' | 'miss' | 'skipped' | 'error'> {
    if (!isWaybackRescuable(meta)) return 'skipped';
    const claimKey = `${ARCHIVE_AUDIT_RESCUE_PREFIX}${meta.jobId}`;
    const claim = await this.redis.set(
      claimKey,
      sourceState,
      'EX',
      sourceState === 'failed' ? 24 * 60 * 60 : 6 * 60 * 60,
      'NX',
    );
    if (claim !== 'OK') return 'skipped';

    try {
      void this.queue.audit(meta.jobId, 'wayback-rescue-start', { reason, sourceState });
      const waybackHit = await fetchWaybackIfFresh(meta.url, this.config.waybackMaxAgeDays);
      if (!waybackHit) {
        void this.queue.audit(meta.jobId, 'wayback-rescue-miss', { reason, sourceState });
        return 'miss';
      }

      const uploadResult = await this.blossom.upload(waybackHit.html, 'text/html');
      const verify = await this.blossom.verify(uploadResult.blobHash);
      if (!verify.ok) {
        throw new RenderError(
          'verify_failed',
          `post-upload HEAD returned ${verify.status} for rescued Wayback blob ${uploadResult.blobHash}`,
          'retryable',
        );
      }

      const mirrorTargets = await resolveMirrorTargets({
        primaryUrl: this.config.blossomPrimaryUrl,
        operatorUrls: this.config.blossomMirrorUrls,
        userUrls: meta.mirrorUrls,
      });
      const mirrorUrls = mirrorTargets.urls;
      const mirrorResults = mirrorUrls.length > 0
        ? await this.blossom.mirror(uploadResult.blobHash, mirrorUrls, waybackHit.html, 'text/html')
        : [];
      const allMirrorResults = [...mirrorTargets.rejected, ...mirrorResults];
      const files: ArchiveFileRecord[] = [{
        role: 'html',
        blobHash: uploadResult.blobHash,
        url: meta.url,
        source: 'wayback',
        contentType: 'text/html',
        mirrors: allMirrorResults,
      }];

      await this.notifyPaymentProxy({
        jobId: meta.jobId,
        status: 'ok',
        blobHash: uploadResult.blobHash,
        source: 'wayback',
        tier: 'public',
        ownerPubkey: meta.ownerPubkey,
        url: meta.url,
        mirrors: allMirrorResults,
        bookmarkSavedAt: meta.bookmarkSavedAt,
        kind: 'webpage',
        contentType: 'text/html',
        files,
      });

      await this.queue.complete({
        jobId: meta.jobId,
        status: 'ok',
        blobHash: uploadResult.blobHash,
        source: 'wayback',
        completedAt: Math.floor(Date.now() / 1000),
        bookmarkSavedAt: meta.bookmarkSavedAt,
        contentType: 'text/html',
        files,
      });

      this.log.info(
        { jobId: meta.jobId, url: meta.url, hash: uploadResult.blobHash, capturedAt: waybackHit.capturedAt },
        'archive rescued from Wayback',
      );
      void this.queue.audit(meta.jobId, 'wayback-rescue-complete', {
        blobHash: uploadResult.blobHash,
        capturedAt: waybackHit.capturedAt,
      });
      return 'rescued';
    } catch (err) {
      this.log.warn({ err, jobId: meta.jobId, url: meta.url }, 'Wayback archive rescue failed');
      void this.queue.audit(meta.jobId, 'wayback-rescue-error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 'error';
    }
  }

  private async markLostArchiveFailed(meta: ArchiveJobMetadata, reason: string): Promise<boolean> {
    const claim = await this.redis.set(
      `${ARCHIVE_AUDIT_LOST_FAILED_PREFIX}${meta.jobId}`,
      '1',
      'EX',
      60 * 60 * 24 * 30,
      'NX',
    );
    if (claim !== 'OK') return false;

    let callbackPending = false;
    await this.notifyPaymentProxy({
      jobId: meta.jobId,
      status: 'failed',
      error: reason,
      errorCategory: 'permanent',
      ownerPubkey: meta.ownerPubkey,
      paymentHash: meta.paymentHash,
      url: meta.url,
      tier: meta.tier,
      kind: meta.kind ?? 'webpage',
      videoId: meta.videoId,
      videoContentKey: meta.videoContentKey,
      bookmarkSavedAt: meta.bookmarkSavedAt,
    }).catch((err) => {
      callbackPending = true;
      this.log.warn({ err, jobId: meta.jobId }, 'archive audit lost-job failure callback failed');
    });
    await this.queue.complete({
      jobId: meta.jobId,
      status: 'failed',
      error: reason,
      errorCategory: 'permanent',
      callbackPending,
      completedAt: Math.floor(Date.now() / 1000),
      bookmarkSavedAt: meta.bookmarkSavedAt,
    });
    void this.queue.audit(meta.jobId, 'lost-job-marked-failed', { reason });
    return true;
  }

  private async tryArchiveScholarlyPdf(opts: {
    job: ArchiveJob;
    pdfUrl: string;
    mirrorUrls: string[];
    rejectedMirrors: Array<{ url: string; ok: boolean; error?: string }>;
    queue: ArchiveQueue;
  }): Promise<ArchiveFileRecord | null> {
    const { job, pdfUrl, mirrorUrls, rejectedMirrors, queue } = opts;
    if (sameUrlIgnoringHash(job.url, pdfUrl)) return null;
    try {
      void queue.audit(job.jobId, 'scholarly-pdf-start', { pdfUrl });
      const pdf = await tryDownloadDirectFileArchive(pdfUrl, { force: true });
      if (!pdf || !pdf.contentType.includes('application/pdf')) {
        void queue.audit(job.jobId, 'scholarly-pdf-skipped', {
          pdfUrl,
          reason: pdf ? `unsupported content type ${pdf.contentType}` : 'not a direct PDF',
        });
        return null;
      }

      let uploadBytes = pdf.bytes;
      const uploadContentType = job.tier === 'private' ? 'application/octet-stream' : pdf.contentType;
      if (job.tier === 'private') {
        if (!job.archiveKey) return null;
        uploadBytes = encryptBlob(pdf.bytes, job.archiveKey);
        zeroize(pdf.bytes);
      }

      const uploadResult = await this.blossom.upload(uploadBytes, uploadContentType);
      const verify = await this.blossom.verify(uploadResult.blobHash);
      if (!verify.ok) {
        void queue.audit(job.jobId, 'scholarly-pdf-verify-failed', {
          pdfUrl,
          blobHash: uploadResult.blobHash,
          status: verify.status,
        });
        return null;
      }

      const mirrorResults = mirrorUrls.length > 0
        ? await this.blossom.mirror(uploadResult.blobHash, mirrorUrls, uploadBytes, uploadContentType)
        : [];
      const mirrors = [...rejectedMirrors, ...mirrorResults];
      this.log.info(
        { jobId: job.jobId, pdfUrl, blobHash: uploadResult.blobHash, mirrors: mirrors.length },
        'scholarly PDF archive uploaded',
      );
      void queue.audit(job.jobId, 'scholarly-pdf-complete', {
        pdfUrl,
        blobHash: uploadResult.blobHash,
        contentType: pdf.contentType,
        fileName: pdf.fileName,
      });
      return {
        role: 'pdf',
        blobHash: uploadResult.blobHash,
        url: pdfUrl,
        source: 'file',
        contentType: pdf.contentType,
        fileName: pdf.fileName,
        mirrors,
      };
    } catch (err) {
      this.log.warn({ jobId: job.jobId, pdfUrl, err }, 'scholarly PDF archive skipped');
      void queue.audit(job.jobId, 'scholarly-pdf-failed', {
        pdfUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Media archive branch. Runs yt-dlp to download the primary video/audio
   * at ≤720p for video, encrypts client-side
   * with the user's archive key, uploads the encrypted blob to
   * Blossom, and reports back to payment-proxy with the resolved
   * title + channel so the UI can render "Title — Channel" instead
   * of a bare video id.
   *
   * Always private regardless of `job.tier` — the source URL is
   * still public on the source site, but the downloaded video stays in our
   * encrypted store, keyed only to the user.
   *
   * Every purchase gets its own encrypted blob because the archive key is
   * generated client-side per user. Reusing a different user's ciphertext
   * would leave the new buyer with the wrong decrypt key.
   */
  private async processVideoJob(job: ArchiveJob, queue: ArchiveQueue): Promise<void> {
    const startedAt = Date.now();
    void queue.audit(job.jobId, 'taken', { url: job.url, kind: job.kind ?? 'video', attempt: job.attempts });
    try {
      if (!job.archiveKey) {
        throw new PermanentError('missing_archive_key', 'media job missing archiveKey');
      }
      let safeSourceUrl: string;
      try {
        safeSourceUrl = (await resolveSafePublicHttpUrl(job.url)).toString();
      } catch (err) {
        const reason = err instanceof UnsafeUrlError ? err.message : String(err);
        this.log.warn({ jobId: job.jobId, url: job.url, reason }, 'rejecting unsafe media url');
        await queue.complete({
          jobId: job.jobId,
          status: 'failed',
          error: reason,
          errorCategory: 'permanent',
          completedAt: Math.floor(Date.now() / 1000),
        });
        return;
      }

      // Stable source identifier for metadata and future grouping. It is
      // intentionally NOT used to reuse private ciphertext across users:
      // each buyer supplies a fresh archiveKey and needs bytes encrypted
      // with that exact key.
      const contentKey = job.videoContentKey
        ?? (job.videoId ? `yt:${job.videoId.toLowerCase()}` : `video:${job.url}`);

      // Download the primary media. Direct image/audio/video files and
      // podcast episode pages stay out of yt-dlp when we can resolve
      // their bytes directly; hosted video pages fall back to yt-dlp.
      void queue.audit(job.jobId, 'media-download-start');
      const { result, source } = await this.resolveMediaArchiveSource(job, safeSourceUrl);
      void queue.audit(job.jobId, 'media-download-end', {
        bytes: result.blob.byteLength,
        title: result.title,
        channel: result.channel,
        durationSeconds: result.durationSeconds,
        mediaKind: result.mediaKind,
      });

      // Encrypt — media archives are always private.
      const encrypted = encryptBlob(result.blob, job.archiveKey);
      zeroize(result.blob);

      const uploadResult = await this.blossom.upload(encrypted, 'application/octet-stream');
      this.log.info(
        { jobId: job.jobId, contentKey, videoId: job.videoId, blobHash: uploadResult.blobHash, bytes: encrypted.byteLength },
        'media archive uploaded',
      );
      void queue.audit(job.jobId, 'uploaded', {
        blobHash: uploadResult.blobHash,
        size: uploadResult.size,
        mediaKind: result.mediaKind,
      });

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
      void queue.audit(job.jobId, 'verified', {
        blobHash: uploadResult.blobHash,
        reportedSize: verify.size,
      });

      const mirrorTargets = await resolveMirrorTargets({
        primaryUrl: this.config.blossomPrimaryUrl,
        operatorUrls: this.config.blossomMirrorUrls,
        userUrls: job.mirrorUrls,
      });
      const mirrorUrls = mirrorTargets.urls;
      const mirrorResults = mirrorUrls.length > 0
        ? await this.blossom.mirror(uploadResult.blobHash, mirrorUrls, encrypted, 'application/octet-stream')
        : [];
      const allMirrorResults = [...mirrorTargets.rejected, ...mirrorResults];
      if (mirrorUrls.length > 0) {
        const ok = allMirrorResults.filter((r) => r.ok).length;
        const failed = allMirrorResults.length - ok;
        this.log.info(
          { jobId: job.jobId, hash: uploadResult.blobHash, ok, failed, mirrors: allMirrorResults },
          'media blob mirror fanout complete',
        );
        void queue.audit(job.jobId, 'mirrored', {
          blobHash: uploadResult.blobHash,
          ok,
          failed,
          mirrors: allMirrorResults,
        });
      } else {
        this.log.warn({ jobId: job.jobId, hash: uploadResult.blobHash }, 'no Blossom mirror targets configured for media archive');
        void queue.audit(job.jobId, 'mirror-skipped', {
          blobHash: uploadResult.blobHash,
          reason: 'no mirror targets configured',
        });
      }

      const files: ArchiveFileRecord[] = [{
        role: 'media',
        blobHash: uploadResult.blobHash,
        url: job.url,
        source,
        contentType: result.contentType,
        fileName: mediaPrimaryFileName(result),
        mirrors: allMirrorResults,
      }];
      const sidecarFiles = await this.uploadMediaSidecars({
        job,
        sidecars: result.sidecars ?? [],
        archiveKey: job.archiveKey,
        mirrorUrls,
        rejectedMirrors: mirrorTargets.rejected,
        queue,
      });
      files.push(...sidecarFiles);

      await this.notifyPaymentProxy({
        jobId: job.jobId,
        status: 'ok',
        blobHash: uploadResult.blobHash,
        source,
        tier: 'private',
        ownerPubkey: job.ownerPubkey,
        url: job.url,
        kind: 'media',
        contentType: result.contentType,
        fileName: mediaPrimaryFileName(result),
        videoId: job.videoId,
        videoContentKey: contentKey,
        videoTitle: result.title,
        videoChannel: result.channel,
        videoDurationSeconds: result.durationSeconds,
        mirrors: allMirrorResults,
        bookmarkSavedAt: job.bookmarkSavedAt,
        files,
      });

      await queue.complete({
        jobId: job.jobId,
        status: 'ok',
        blobHash: uploadResult.blobHash,
        source,
        completedAt: Math.floor(Date.now() / 1000),
        bookmarkSavedAt: job.bookmarkSavedAt,
        contentType: result.contentType,
        fileName: mediaPrimaryFileName(result),
        videoTitle: result.title,
        videoChannel: result.channel,
        videoDurationSeconds: result.durationSeconds,
        files,
      });

      const durationMs = Date.now() - startedAt;
      this.log.info({ jobId: job.jobId, durationMs }, 'media job complete');
      void queue.audit(job.jobId, 'completed', {
        blobHash: uploadResult.blobHash,
        durationMs,
        videoId: job.videoId,
        videoContentKey: contentKey,
      });
    } catch (err) {
      await this.handleError(job, err, queue);
    }
  }

  private async resolveMediaArchiveSource(
    job: ArchiveJob,
    safeSourceUrl: string,
  ): Promise<{ result: VideoArchiveResult; source: 'rendered' | 'file' }> {
    const directProbe = isLikelyAudioUrl(safeSourceUrl) ||
      isLikelyVideoUrl(safeSourceUrl) ||
      isLikelyImageUrl(safeSourceUrl) ||
      isLikelyStreamingManifestUrl(safeSourceUrl) ||
      isLikelyBlossomBlobUrl(safeSourceUrl);
    if (directProbe) {
      const direct = await tryDownloadDirectFileArchive(safeSourceUrl, { force: isLikelyBlossomBlobUrl(safeSourceUrl) });
      if (direct && isMediaContentType(direct.contentType)) {
        return { result: resultFromDirectMedia(direct, safeSourceUrl), source: 'file' };
      }
    }

    if (shouldTryPodcastPage(safeSourceUrl)) {
      const podcast = await tryResolvePodcastEpisodeArchive(safeSourceUrl).catch((err) => {
        this.log.warn({ jobId: job.jobId, err }, 'podcast enclosure resolution skipped');
        return null;
      });
      if (podcast) {
        return { result: resultFromDirectMedia(podcast, podcast.sourceUrl, podcast.title), source: 'file' };
      }
    }

    return {
      source: 'rendered',
      result: await downloadVideoArchive({ url: safeSourceUrl, videoId: job.videoId }, {
        info: (msg: unknown, obj?: unknown) => this.log.info(obj as object ?? {}, String(msg)),
        warn: (msg: unknown, obj?: unknown) => this.log.warn(obj as object ?? {}, String(msg)),
      }),
    };
  }

  private async uploadMediaSidecars(input: {
    job: ArchiveJob;
    sidecars: MediaSidecar[];
    archiveKey: string;
    mirrorUrls: string[];
    rejectedMirrors: Array<{ url: string; ok: boolean; error?: string }>;
    queue: ArchiveQueue;
  }): Promise<ArchiveFileRecord[]> {
    const files: ArchiveFileRecord[] = [];
    for (const sidecar of input.sidecars.slice(0, 7)) {
      try {
        const encrypted = encryptBlob(sidecar.bytes, input.archiveKey);
        zeroize(sidecar.bytes);
        const upload = await this.blossom.upload(encrypted, 'application/octet-stream');
        const verify = await this.blossom.verify(upload.blobHash);
        if (!verify.ok) {
          void input.queue.audit(input.job.jobId, 'media-sidecar-verify-failed', {
            fileName: sidecar.fileName,
            blobHash: upload.blobHash,
            status: verify.status,
          });
          continue;
        }
        const mirrors = input.mirrorUrls.length > 0
          ? await this.blossom.mirror(upload.blobHash, input.mirrorUrls, encrypted, 'application/octet-stream')
          : [];
        const allMirrors = [...input.rejectedMirrors, ...mirrors];
        files.push({
          role: 'file',
          blobHash: upload.blobHash,
          url: input.job.url,
          source: 'file',
          contentType: sidecar.contentType,
          fileName: sidecar.fileName,
          mirrors: allMirrors,
        });
        void input.queue.audit(input.job.jobId, 'media-sidecar-uploaded', {
          fileName: sidecar.fileName,
          role: sidecar.role,
          blobHash: upload.blobHash,
          size: upload.size,
        });
      } catch (err) {
        this.log.warn({ err, jobId: input.job.jobId, fileName: sidecar.fileName }, 'media sidecar upload skipped');
        void input.queue.audit(input.job.jobId, 'media-sidecar-failed', {
          fileName: sidecar.fileName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return files;
  }

  private async runDeleteLoop(): Promise<void> {
    const deleteRedis = this.redis.duplicate();
    try {
      while (!this.shuttingDown) {
        try {
          const row = await deleteRedis.blpop(KEYS.deleteQueue, 5);
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
    } finally {
      deleteRedis.disconnect();
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

    // Final failure: notify payment-proxy while the job is still in
    // the processing/active Redis keys so Box A can validate the
    // owner/url/tier metadata even for older lifetime jobs whose
    // dm:archive-job:* metadata has expired. Success already follows
    // this notify-before-complete order.
    const record: DoneRecord = {
      jobId: job.jobId,
      status: 'failed',
      error: message,
      errorCategory: category,
      completedAt: Math.floor(Date.now() / 1000),
      bookmarkSavedAt: job.bookmarkSavedAt,
    };
    let callbackPending = false;
    await this.notifyPaymentProxy({
      jobId: job.jobId,
      status: 'failed',
      error: message,
      errorCategory: category,
      ownerPubkey: job.ownerPubkey,
      paymentHash: job.paymentHash,
      url: job.url,
      tier: job.tier ?? 'public',
      kind: job.kind ?? 'webpage',
      videoId: job.videoId,
      videoContentKey: job.videoContentKey,
      bookmarkSavedAt: job.bookmarkSavedAt,
    }).catch((e) => {
      callbackPending = true;
      this.log.error({ err: e }, 'payment-proxy notification failed');
    });
    await queue.complete(callbackPending ? { ...record, callbackPending: true } : record);
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
  if (isPermanentMediaDownloadError(msg)) return 'permanent';
  // Heuristics: network-ish errors are retryable.
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|503|502|504|fetch failed|timeout/i.test(msg)) {
    return 'retryable';
  }
  // Default: retryable. We'd rather spend one extra Playwright launch
  // than permanently fail a user's 500-sat archive over an unknown error.
  return 'retryable';
}

function isPermanentMediaDownloadError(message: string): boolean {
  return /yt-dlp exited \d+:/i.test(message) && (
    /sign in to confirm/i.test(message) ||
    /account authentication is required/i.test(message) ||
    /unsupported url/i.test(message) ||
    /video unavailable/i.test(message) ||
    /no longer available/i.test(message) ||
    /copyright claim/i.test(message) ||
    /private video/i.test(message) ||
    /unable to download api page: HTTP Error 404/i.test(message) ||
    /HTTP Error 404: Not Found/i.test(message)
  );
}

function decodeCapturedHtml(job: ArchiveJob): Buffer | null {
  if (!job.capturedHtmlBase64) return null;
  const raw = job.capturedHtmlBase64.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 === 1) {
    throw new PermanentError('invalid_browser_capture', 'browser capture is not valid base64');
  }
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.byteLength <= 0) {
    throw new PermanentError('empty_browser_capture', 'browser capture produced no bytes');
  }
  if (bytes.byteLength > MAX_BROWSER_CAPTURE_BYTES) {
    throw new PermanentError(
      'browser_capture_too_large',
      `browser capture exceeds ${Math.floor(MAX_BROWSER_CAPTURE_BYTES / 1024 / 1024)} MB`,
    );
  }
  const canonical = bytes.toString('base64').replace(/=+$/, '');
  if (canonical !== raw.replace(/=+$/, '')) {
    throw new PermanentError('invalid_browser_capture', 'browser capture is not valid base64');
  }
  return bytes;
}

function parseArchiveJob(raw: string | null): ArchiveJob | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ArchiveJob>;
    if (
      typeof parsed.jobId !== 'string' ||
      typeof parsed.paymentHash !== 'string' ||
      typeof parsed.ownerPubkey !== 'string' ||
      typeof parsed.url !== 'string' ||
      (parsed.tier !== 'public' && parsed.tier !== 'private') ||
      typeof parsed.enqueuedAt !== 'number'
    ) {
      return null;
    }
    return parsed as ArchiveJob;
  } catch {
    return null;
  }
}

function parseArchiveJobMetadata(raw: string | null): ArchiveJobMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ArchiveJobMetadata>;
    if (
      typeof parsed.jobId !== 'string' ||
      typeof parsed.paymentHash !== 'string' ||
      typeof parsed.ownerPubkey !== 'string' ||
      typeof parsed.url !== 'string' ||
      (parsed.tier !== 'public' && parsed.tier !== 'private') ||
      typeof parsed.enqueuedAt !== 'number'
    ) {
      return null;
    }
    return parsed as ArchiveJobMetadata;
  } catch {
    return null;
  }
}

function parseDoneRecord(raw: string | null): DoneRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DoneRecord>;
    if (parsed.status !== 'ok' && parsed.status !== 'failed') return null;
    if (typeof parsed.jobId !== 'string') return null;
    return parsed as DoneRecord;
  } catch {
    return null;
  }
}

function isWaybackRescuable(meta: ArchiveJobMetadata): boolean {
  const kind = meta.kind ?? 'webpage';
  return meta.tier === 'public' && kind === 'webpage';
}

function isMetadataReplayableArchive(meta: ArchiveJobMetadata): boolean {
  const kind = meta.kind ?? 'webpage';
  return meta.tier === 'public' && (kind === 'webpage' || kind === 'file');
}

function resultFromDirectMedia(
  archive: DirectFileArchive,
  sourceUrl: string,
  title = archive.fileName,
): VideoArchiveResult {
  return {
    blob: archive.bytes,
    title: title || archive.fileName || hostOrUrl(sourceUrl),
    channel: hostOrUrl(sourceUrl),
    durationSeconds: 0,
    mediaKind: mediaKindForContentType(archive.contentType),
    contentType: archive.contentType,
    fileName: archive.fileName,
  };
}

function mediaKindForContentType(contentType: string): VideoArchiveResult['mediaKind'] {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('image/')) return 'image';
  return 'video';
}

function isMediaContentType(contentType: string): boolean {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return normalized.startsWith('audio/') ||
    normalized.startsWith('video/') ||
    normalized.startsWith('image/');
}

function safePublicArchiveContentType(contentType: string): string {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  // SVG is active content in browsers. Preserve the original type in the
  // archive record, but serve the public blob as a download from Blossom.
  if (normalized === 'image/svg+xml') return 'application/octet-stream';
  return contentType;
}

function mediaPrimaryFileName(result: VideoArchiveResult): string | undefined {
  return result.fileName;
}

function isLikelyBlossomBlobUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const path = url.pathname.split('/').filter(Boolean)[0] ?? '';
    return /(^|\.)blossom/i.test(url.hostname) && /^[0-9a-f]{64}$/i.test(path);
  } catch {
    return false;
  }
}

function shouldTryPodcastPage(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
    return ![
      'youtube.com',
      'youtu.be',
      'vimeo.com',
      'rumble.com',
      'odysee.com',
      'lbry.tv',
      'twitch.tv',
      'tiktok.com',
      'instagram.com',
      'reddit.com',
      'x.com',
      'twitter.com',
      'imgur.com',
    ].some((known) => host === known || host.endsWith(`.${known}`));
  } catch {
    return false;
  }
}

function hostOrUrl(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return raw;
  }
}

function archivePrimaryFile(done: DoneRecord): ArchiveFileRecord | undefined {
  return done.files?.find((file) => file.blobHash === done.blobHash) ?? done.files?.[0];
}

function archiveKindForDone(meta: ArchiveJobMetadata, done: DoneRecord): ArchiveJob['kind'] {
  if (meta.kind && meta.kind !== 'webpage') return meta.kind;
  const role = archivePrimaryFile(done)?.role;
  if (role === 'file' || role === 'pdf') return 'file';
  if (role === 'media') return 'media';
  return 'webpage';
}

function decodeNsec(nsec: string): string {
  // Decode a bech32 nsec to hex. nip19 is imported statically at the top
  // of the file so this works under ESM (module was previously using
  // `require()` which broke at runtime on Node 20).
  const decoded = nip19.decode(nsec);
  if (decoded.type !== 'nsec') throw new Error(`expected nsec, got ${decoded.type}`);
  return Buffer.from(decoded.data as Uint8Array).toString('hex');
}

function primaryArchiveFileRole(
  kind: 'webpage' | 'file',
  contentType: string,
): ArchiveFileRecord['role'] {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (normalized === 'application/pdf') return 'pdf';
  if (normalized.startsWith('video/') || normalized.startsWith('audio/')) return 'media';
  return kind === 'file' ? 'file' : 'html';
}

function sameUrlIgnoringHash(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = '';
    b.hash = '';
    return a.toString() === b.toString();
  } catch {
    return left === right;
  }
}
