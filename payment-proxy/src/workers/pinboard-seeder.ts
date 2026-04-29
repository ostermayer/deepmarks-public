// Runs the Pinboard seeder in the background on a fixed cadence (default
// every 4 hours). Idempotency lives in seedOnce() — this worker just
// decides when to call it.
//
// Gate with SEED_PINBOARD_INTERVAL_HOURS:
//   unset / 0 / negative → worker disabled (dev default)
//   N > 0                → run at boot, then every N hours

import type { SimplePool } from 'nostr-tools';
import { seedOnce, defaultCandidateRelays, type SeedLogger } from '../seed/runner.js';
import type { RemoteSigner } from '../signer.js';

export interface PinboardSeederDeps {
  pool: SimplePool;
  logger: SeedLogger;
  /** Brand signer — seeder publishes kind 39701 events under this identity. */
  signer: RemoteSigner;
  /** Test hook — lets the suite inject a fake seeder + fake clock. */
  seedFn?: typeof seedOnce;
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

export class PinboardSeederWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly deps: PinboardSeederDeps,
    /** Interval in hours. <= 0 disables the worker. */
    public readonly intervalHours: number,
  ) {}

  get enabled(): boolean {
    return this.intervalHours > 0;
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      this.deps.logger.info('pinboard seeder disabled (SEED_PINBOARD_INTERVAL_HOURS unset or 0)');
      return;
    }
    this.stopped = false;
    // Run immediately so a fresh boot seeds without waiting a full interval,
    // then schedule.
    void this.runOnce();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      (this.deps.clearTimer ?? clearTimeout)(this.timer);
      this.timer = null;
    }
  }

  private async runOnce(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const seed = this.deps.seedFn ?? seedOnce;
      const result = await seed({
        apply: true,
        candidateRelays: defaultCandidateRelays(),
        pool: this.deps.pool,
        logger: this.deps.logger,
        signer: this.deps.signer,
      });
      this.deps.logger.info(
        `pinboard seeder: +${result.ok} new events (${result.failed} failed, ${result.alreadyPublished} already present)`,
      );
    } catch (e) {
      this.deps.logger.error(`pinboard seeder threw: ${(e as Error).message}`);
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (this.stopped || !this.enabled) return;
    const ms = this.intervalHours * 60 * 60 * 1000;
    this.timer = (this.deps.setTimer ?? setTimeout)(() => {
      this.timer = null;
      void this.runOnce();
    }, ms);
  }
}

/** Read the interval from env — tolerant of blanks and invalid values. */
export function seederIntervalFromEnv(): number {
  const raw = process.env.SEED_PINBOARD_INTERVAL_HOURS;
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
