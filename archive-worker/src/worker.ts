import Redis from 'ioredis';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { getPublicKey, nip19 } from 'nostr-tools';
import { ArchiveQueue, type ArchiveJob, type DoneRecord } from './queue.js';
import { fetchWaybackIfFresh } from './wayback.js';
import { PageRenderer, RenderError } from './renderer.js';
import { encryptBlob, zeroize } from './crypto.js';
import { BlossomClient } from './blossom.js';
import { assertSafePublicHttpUrl, UnsafeUrlError } from './safe-url.js';

/**
 * Main worker loop.
 *
 * Flow per job (matches Flow O in architecture):
 *   1. BLMOVE a job from dm:archive:queue → dm:archive:processing:<wid>
 *   2. Try Wayback (if snapshot <WAYBACK_MAX_AGE_DAYS days old)
 *   3. Else render with Playwright + SingleFile
 *   4. If tier=private, AES-256-GCM encrypt with archiveKey
 *   5. Upload to primary Blossom, fan out to mirrors
 *   6. Write done record, publish event, notify payment-proxy
 *
 * Retry: 3 attempts with 1/5/30-min backoff (scheduled in Redis,
 * handled by Box A's supervisor re-queueing).
 */

export interface WorkerConfig {
  redisUrl: string;
  blossomPrimaryUrl: string;
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

const BACKOFF_SCHEDULE_SECONDS = [60, 300, 1800]; // 1min, 5min, 30min
const MAX_ATTEMPTS = BACKOFF_SCHEDULE_SECONDS.length;

export class Worker {
  private redis: Redis;
  private queue: ArchiveQueue;
  private renderer: PageRenderer;
  private blossom: BlossomClient;
  private log: pino.Logger;
  private shuttingDown = false;
  private activeJobs = 0;

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
    // Concurrency: spawn N parallel job-processing loops against the
    // same queue. Each BLMOVEs independently; Redis serializes handoff.
    const loops: Promise<void>[] = [];
    for (let i = 0; i < this.config.maxConcurrentJobs; i++) {
      loops.push(this.runLoop(i));
    }
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
    while (!this.shuttingDown) {
      try {
        // BLMOVE with 5s timeout so we can check shuttingDown regularly.
        const job = await this.queue.takeJob(5);
        if (!job) continue;

        this.log.info(
          { jobId: job.jobId, url: job.url, attempt: job.attempts, loop: loopIndex },
          'picked up job',
        );

        this.activeJobs += 1;
        try {
          await this.processJob(job);
        } finally {
          this.activeJobs -= 1;
        }
      } catch (err) {
        this.log.error({ err }, 'unexpected error in worker loop');
        // Don't crash the loop; pause briefly and continue.
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }

  private async processJob(job: ArchiveJob): Promise<void> {
    const startedAt = Date.now();
    void this.queue.audit(job.jobId, 'taken', { url: job.url, attempt: job.attempts });
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
        await this.queue.complete({
          jobId: job.jobId,
          status: 'failed',
          error: reason,
          errorCategory: 'permanent',
          completedAt: Math.floor(Date.now() / 1000),
        });
        return;
      }

      // Step 1: fetch or render the page.
      let plaintext: Buffer;
      let screenshot: Buffer | null = null;
      let source: 'wayback' | 'rendered';

      const waybackHit = await fetchWaybackIfFresh(job.url, this.config.waybackMaxAgeDays);
      if (waybackHit) {
        plaintext = waybackHit.html;
        source = 'wayback';
        this.log.info(
          { jobId: job.jobId, capturedAt: waybackHit.capturedAt },
          'using wayback snapshot',
        );
        void this.queue.audit(job.jobId, 'wayback-hit', {
          bytes: plaintext.byteLength,
          capturedAt: waybackHit.capturedAt,
        });
      } else {
        void this.queue.audit(job.jobId, 'render-start');
        const result = await this.renderer.render(job.url);
        plaintext = result.html;
        screenshot = result.screenshot;
        source = 'rendered';
        this.log.info(
          { jobId: job.jobId, bytes: plaintext.byteLength, screenshotBytes: screenshot?.byteLength ?? 0 },
          'rendered via playwright',
        );
        void this.queue.audit(job.jobId, 'render-end', {
          bytes: plaintext.byteLength,
          screenshotBytes: screenshot?.byteLength ?? 0,
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
        this.blossom.upload(finalBlob),
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
      void this.queue.audit(job.jobId, 'uploaded', {
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
        void this.queue.audit(job.jobId, 'verify-failed', {
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
      void this.queue.audit(job.jobId, 'verified', {
        blobHash: uploadResult.blobHash,
        reportedSize: verify.size,
      });

      // Step 4: notify payment-proxy, which records the archive and
      // kicks off mirror fanout (since it knows the user's mirror list).
      // We could mirror directly from the worker, but the user's
      // mirror list lives in their account record on Box A — cleaner
      // to let payment-proxy own that orchestration.
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
      });

      // Step 5: mark done in Redis + publish event.
      await this.queue.complete({
        jobId: job.jobId,
        status: 'ok',
        blobHash: uploadResult.blobHash,
        source,
        completedAt: Math.floor(Date.now() / 1000),
      });

      const durationMs = Date.now() - startedAt;
      this.log.info({ jobId: job.jobId, durationMs }, 'job complete');
      void this.queue.audit(job.jobId, 'completed', {
        blobHash: uploadResult.blobHash,
        durationMs,
      });
    } catch (err) {
      await this.handleError(job, err);
    }
  }

  private async handleError(job: ArchiveJob, err: unknown): Promise<void> {
    const category = categorize(err);
    const message = err instanceof Error ? err.message : String(err);
    this.log.warn(
      { jobId: job.jobId, attempt: job.attempts, category, error: message },
      'job failed',
    );
    void this.queue.audit(job.jobId, 'attempt-failed', {
      attempt: job.attempts,
      category,
      error: message,
    });

    const shouldRetry = category === 'retryable' && job.attempts < MAX_ATTEMPTS - 1;

    if (shouldRetry) {
      const backoffSec = BACKOFF_SCHEDULE_SECONDS[job.attempts] ?? 1800;
      this.log.info(
        { jobId: job.jobId, retryInSec: backoffSec },
        'scheduling retry',
      );
      // We don't hold the worker during backoff; re-enqueue with a
      // delayed-visibility hack. Simplest: requeue with a "not before"
      // timestamp the worker checks on pickup. For MVP simplicity
      // we just requeue immediately and let the retry happen on the
      // next free worker — backoff is approximated. A production
      // version would use a sorted-set delay queue.
      setTimeout(() => {
        this.queue.requeue(job).catch((e) => {
          this.log.error({ err: e }, 'requeue failed');
        });
      }, backoffSec * 1000);
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
    await this.queue.complete(record);
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
