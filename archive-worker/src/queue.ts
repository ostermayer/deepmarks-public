import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

/**
 * Redis-backed job queue for archive jobs.
 *
 * Protocol (see Flow O in architecture doc):
 *   dm:archive:queue             — FIFO list of pending jobs
 *   dm:archive:active:<wid>      — per-worker active job with heartbeat
 *   dm:archive:staged:<jobId>    — 15-min TTL intermediate blob
 *   dm:archive:done:<jobId>      — terminal record, 24h TTL
 *   dm:archive:events            — pub/sub channel for status transitions
 *
 * Box A has a supervisor process that reclaims jobs with stale
 * heartbeats (>60s); we just need to refresh ours on a timer.
 */

export const KEYS = {
  queue: 'dm:archive:queue',
  /** Per-worker durable in-flight list. takeJob does BLMOVE from
   *  KEYS.queue to KEYS.processing(wid) so a job stays in Redis even
   *  if the worker dies between popping and processing. complete /
   *  requeue removes the JSON from the processing list. recoverOrphans
   *  on startup scans every dm:archive:processing:* key and re-queues
   *  items left from previous (now-dead) worker IDs. */
  processing: (wid: string) => `dm:archive:processing:${wid}`,
  /** Per-worker active-job key — JSON of the current job + heartbeat
   *  TTL. Distinct from KEYS.processing (a list) — this is for the
   *  Box A supervisor's stale-worker check; the list is for crash
   *  recovery. Both are cleared on complete/requeue. */
  active: (wid: string) => `dm:archive:active:${wid}`,
  staged: (jobId: string) => `dm:archive:staged:${jobId}`,
  done: (jobId: string) => `dm:archive:done:${jobId}`,
  /** Append-only per-job audit trail. One LPUSHed JSON entry per state
   *  transition: enqueued / taken / wayback-hit / render-start / render-end /
   *  uploaded / verified / completed / failed / requeued. 7-day TTL —
   *  long enough for after-the-fact investigation of a "where did my
   *  archive go" report, short enough that the keyspace stays bounded. */
  audit: (jobId: string) => `dm:archive:audit:${jobId}`,
  events: 'dm:archive:events',
} as const;

export interface ArchiveJob {
  jobId: string;
  paymentHash: string;
  ownerPubkey: string;
  url: string;
  tier: 'private' | 'public';
  /** Base64 AES-256-GCM key (32 bytes). Only present when tier is "private". */
  archiveKey: string | null;
  attempts: number;
  enqueuedAt: number;
}

export interface DoneRecord {
  jobId: string;
  status: 'ok' | 'failed';
  blobHash?: string;
  source?: 'wayback' | 'rendered';
  error?: string;
  errorCategory?: 'retryable' | 'permanent';
  completedAt: number;
}

/** Hard cap on retry attempts — past this we drop the job rather than
 *  loop forever. A poison pill (URL that always crashes the renderer)
 *  would otherwise cycle through the queue indefinitely, blocking
 *  legitimate work behind it. */
export const MAX_ATTEMPTS = 5;

export class ArchiveQueue {
  readonly workerId: string;
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly redis: Redis,
    private readonly heartbeatIntervalMs: number,
  ) {
    this.workerId = `w-${randomUUID()}`;
  }

  /**
   * Block up to `timeoutSeconds` waiting for a job. Atomically pops from
   * the queue and writes the active-job key with our workerId. Returns
   * null on timeout (caller should loop).
   *
   * Corrupt JSON entries are silently dropped (logged via the supervisor's
   * Redis monitoring) so a single bad entry doesn't kill the worker
   * loop. Without this the JSON.parse throws, the loop bubbles, and
   * the worker exits — every healthy job behind the bad one stalls
   * until manual intervention.
   */
  async takeJob(timeoutSeconds: number): Promise<ArchiveJob | null> {
    // BLMOVE atomically pops from queue and pushes to our per-worker
    // processing list. Replaces the earlier BLPOP+SET pattern, where
    // a worker that died between the BLPOP and the active-key SET
    // would lose the job (it was popped from the queue but nowhere
    // else). Now if the worker dies, the job sits in
    // dm:archive:processing:<workerId> and recoverOrphans on the next
    // worker startup re-queues it.
    //
    // BLMOVE source destination LEFT RIGHT timeout — pop from head of
    // source, push to tail of destination. ioredis returns the moved
    // item or null on timeout.
    const raw = await this.redis.blmove(
      KEYS.queue,
      KEYS.processing(this.workerId),
      'LEFT',
      'RIGHT',
      timeoutSeconds,
    );
    if (!raw) return null;
    let job: ArchiveJob;
    try {
      job = JSON.parse(raw) as ArchiveJob;
    } catch {
      // Bad JSON — drop from the processing list so it doesn't
      // re-queue on next recoverOrphans. The bytes are unrecoverable.
      await this.redis.lrem(KEYS.processing(this.workerId), 1, raw).catch(() => {});
      return null;
    }
    // Active-job key keeps the supervisor's stale-worker reclaim
    // path working — different from the processing list (which is
    // for crash recovery). 90s TTL = 1.5x the supervisor's 60s
    // stale threshold.
    await this.redis.set(KEYS.active(this.workerId), raw, 'EX', 90);
    this.startHeartbeat(job, raw);
    return job;
  }

  /** Move every JSON entry left in `dm:archive:processing:*` (across
   *  ALL worker IDs, including dead ones) back onto the main queue.
   *  Called on worker startup. The current worker's own processing
   *  list is included — restart-during-job-process means the
   *  in-flight job hadn't finished, and re-queueing it is the right
   *  recovery (the new worker instance will re-take it via BLMOVE). */
  async recoverOrphans(): Promise<{ recovered: number }> {
    let recovered = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(
        cursor, 'MATCH', 'dm:archive:processing:*', 'COUNT', 100,
      );
      cursor = next;
      for (const key of keys) {
        const items = await this.redis.lrange(key, 0, -1);
        if (items.length === 0) {
          await this.redis.del(key);
          continue;
        }
        const pipeline = this.redis.multi();
        // RPUSH preserves the order they were processed (oldest first).
        // It puts them at the BACK of the queue — fairer than skipping
        // ahead of jobs that landed while the worker was down.
        for (const item of items) pipeline.rpush(KEYS.queue, item);
        pipeline.del(key);
        await pipeline.exec();
        recovered += items.length;
      }
    } while (cursor !== '0');
    return { recovered };
  }

  private rawJobInFlight: string | null = null;
  private startHeartbeat(_job: ArchiveJob, raw: string): void {
    this.stopHeartbeat();
    this.rawJobInFlight = raw;
    this.heartbeat = setInterval(() => {
      // Refresh TTL. If this fails (Redis hiccup), Box A's supervisor
      // will eventually reclaim the job, which is fine.
      this.redis.expire(KEYS.active(this.workerId), 90).catch(() => {});
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  /**
   * Re-enqueue a job for retry. Increments attempts. Caller is
   * responsible for the backoff delay before calling this (typically
   * by scheduling a setTimeout).
   *
   * Returns true when the job was put back, false when it hit
   * MAX_ATTEMPTS and was finalized as a permanent failure instead —
   * caller should treat the latter as terminal (no further retry).
   * Without this cap, a poison-pill URL would cycle indefinitely and
   * head-of-line block every healthy job behind it.
   */
  async requeue(job: ArchiveJob): Promise<boolean> {
    const next: ArchiveJob = { ...job, attempts: job.attempts + 1 };
    if (next.attempts >= MAX_ATTEMPTS) {
      await this.complete({
        jobId: job.jobId,
        status: 'failed',
        error: `gave up after ${MAX_ATTEMPTS} attempts`,
        errorCategory: 'permanent',
        completedAt: Math.floor(Date.now() / 1000),
      });
      return false;
    }
    // RPUSH to send it to the back of the queue — other pending jobs
    // should get a fair shot before a retry. Also drop from the
    // per-worker processing list (we're handing it back to the queue).
    const pipeline = this.redis.multi();
    pipeline.rpush(KEYS.queue, JSON.stringify(next));
    if (this.rawJobInFlight) {
      pipeline.lrem(KEYS.processing(this.workerId), 1, this.rawJobInFlight);
    }
    pipeline.del(KEYS.active(this.workerId));
    await pipeline.exec();
    this.stopHeartbeat();
    return true;
  }

  /**
   * Mark job as terminally done (success or permanent failure).
   * Writes the done record (24h TTL), publishes to the events channel,
   * clears the active-job key.
   */
  async complete(record: DoneRecord): Promise<void> {
    const pipeline = this.redis.multi();
    pipeline.set(KEYS.done(record.jobId), JSON.stringify(record), 'EX', 86_400);
    pipeline.publish(KEYS.events, JSON.stringify({ jobId: record.jobId, status: record.status }));
    pipeline.del(KEYS.active(this.workerId));
    // Drop the job from the per-worker processing list — it's done,
    // not in-flight anymore, so the next recoverOrphans call mustn't
    // re-queue it. LREM by exact JSON value (count=1).
    if (this.rawJobInFlight) {
      pipeline.lrem(KEYS.processing(this.workerId), 1, this.rawJobInFlight);
    }
    // Surface per-op errors. A silent SET failure here would leave the
    // job hanging in the active-job key (heartbeat already stopped),
    // looking to the supervisor like a worker that quietly died — and
    // the supervisor's reclaim path would re-enqueue a job that's
    // actually completed.
    const results = (await pipeline.exec()) as Array<[Error | null, unknown]> | null;
    this.stopHeartbeat();
    this.rawJobInFlight = null;
    if (!results) throw new Error('archive-queue complete pipeline returned null');
    for (const entry of results) {
      const err = entry?.[0];
      if (err) throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Append a state transition to the per-job audit trail. Best-effort —
   * a Redis hiccup here must NOT take down the job, so we swallow
   * errors. The trail is for post-hoc investigation only ("where did
   * my archive go?"), not load-bearing for correctness.
   *
   * Each entry: {at, state, workerId, ...detail}. LPUSH so newest
   * is first when LRANGEd; LTRIM cap of 50 entries protects against
   * a runaway loop.
   */
  async audit(jobId: string, state: string, detail: Record<string, unknown> = {}): Promise<void> {
    const entry = JSON.stringify({
      at: Date.now(),
      state,
      workerId: this.workerId,
      ...detail,
    });
    try {
      const pipeline = this.redis.multi();
      pipeline.lpush(KEYS.audit(jobId), entry);
      pipeline.ltrim(KEYS.audit(jobId), 0, 49);
      pipeline.expire(KEYS.audit(jobId), 7 * 24 * 60 * 60);
      await pipeline.exec();
    } catch {
      // Audit is best-effort — never fail a job over it.
    }
  }

  /**
   * Stage an intermediate blob (ciphertext for private tier, plaintext
   * for public tier) with 15-min TTL. Used to hand the blob from
   * render → upload without writing to disk.
   */
  async stageBlob(jobId: string, blob: Buffer, ttlSeconds: number): Promise<void> {
    await this.redis.set(KEYS.staged(jobId), blob, 'EX', ttlSeconds);
  }

  async unstageBlob(jobId: string): Promise<void> {
    await this.redis.del(KEYS.staged(jobId));
  }
}
