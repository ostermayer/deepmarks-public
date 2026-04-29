import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SimplePool, EventTemplate, Event as NostrEvent } from 'nostr-tools';
import { PinboardSeederWorker, seederIntervalFromEnv } from './pinboard-seeder.js';
import type { SeedResult } from '../seed/runner.js';
import type { RemoteSigner } from '../signer.js';

const fakeSigner: RemoteSigner = {
  pubkey: 'f'.repeat(64),
  async sign(_t: EventTemplate): Promise<NostrEvent> {
    throw new Error('fakeSigner.sign called unexpectedly in worker test');
  },
  close() {},
};

function mkLogger() {
  return {
    logs: [] as string[],
    info(m: string) { this.logs.push(`info:${m}`); },
    warn(m: string) { this.logs.push(`warn:${m}`); },
    error(m: string) { this.logs.push(`error:${m}`); },
  };
}

const OK_RESULT: SeedResult = {
  fetched: 10,
  unique: 10,
  alreadyPublished: 3,
  fresh: 7,
  ok: 7,
  failed: 0,
  perRelayFailures: {},
};

const fakePool = {} as SimplePool;

describe('seederIntervalFromEnv', () => {
  const ORIG = { ...process.env };
  beforeEach(() => { process.env = { ...ORIG }; });

  it('returns 0 when unset', () => {
    delete process.env.SEED_PINBOARD_INTERVAL_HOURS;
    expect(seederIntervalFromEnv()).toBe(0);
  });
  it('returns 0 when blank', () => {
    process.env.SEED_PINBOARD_INTERVAL_HOURS = '   ';
    expect(seederIntervalFromEnv()).toBe(0);
  });
  it('parses numeric values', () => {
    process.env.SEED_PINBOARD_INTERVAL_HOURS = '4';
    expect(seederIntervalFromEnv()).toBe(4);
  });
  it('rejects non-numeric / non-positive values', () => {
    process.env.SEED_PINBOARD_INTERVAL_HOURS = 'nope';
    expect(seederIntervalFromEnv()).toBe(0);
    process.env.SEED_PINBOARD_INTERVAL_HOURS = '0';
    expect(seederIntervalFromEnv()).toBe(0);
    process.env.SEED_PINBOARD_INTERVAL_HOURS = '-5';
    expect(seederIntervalFromEnv()).toBe(0);
  });
});

describe('PinboardSeederWorker', () => {
  it('is a no-op when intervalHours <= 0', async () => {
    const log = mkLogger();
    const seedFn = vi.fn(async () => OK_RESULT);
    const worker = new PinboardSeederWorker(
      { pool: fakePool, logger: log, signer: fakeSigner, seedFn },
      0,
    );
    expect(worker.enabled).toBe(false);
    await worker.start();
    expect(seedFn).not.toHaveBeenCalled();
    expect(log.logs.some((l) => l.includes('disabled'))).toBe(true);
  });

  it('runs seedOnce at boot when enabled', async () => {
    const log = mkLogger();
    const seedFn = vi.fn(async () => OK_RESULT);
    const setTimer = vi.fn(() => 0 as unknown as ReturnType<typeof setTimeout>);
    const worker = new PinboardSeederWorker(
      { pool: fakePool, logger: log, signer: fakeSigner, seedFn, setTimer },
      4,
    );
    await worker.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(seedFn).toHaveBeenCalledTimes(1);
    expect(seedFn).toHaveBeenCalledWith(expect.objectContaining({ apply: true }));
  });

  it('schedules the next run at the configured interval', async () => {
    const log = mkLogger();
    const seedFn = vi.fn(async () => OK_RESULT);
    const setTimer = vi.fn(() => 0 as unknown as ReturnType<typeof setTimeout>);
    const worker = new PinboardSeederWorker(
      { pool: fakePool, logger: log, signer: fakeSigner, seedFn, setTimer },
      4,
    );
    await worker.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 4 * 60 * 60 * 1000);
  });

  it('catches errors from seedOnce and re-schedules instead of exiting', async () => {
    const log = mkLogger();
    const seedFn = vi.fn(async () => { throw new Error('relay blew up'); });
    const setTimer = vi.fn(() => 0 as unknown as ReturnType<typeof setTimeout>);
    const worker = new PinboardSeederWorker(
      { pool: fakePool, logger: log, signer: fakeSigner, seedFn, setTimer },
      4,
    );
    await worker.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(log.logs.some((l) => l.startsWith('error:') && l.includes('relay blew up'))).toBe(true);
    // Still re-scheduled despite the failure.
    expect(setTimer).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels the pending timer and stops subsequent runs', async () => {
    const log = mkLogger();
    const seedFn = vi.fn(async () => OK_RESULT);
    const token = Symbol('tok') as unknown as ReturnType<typeof setTimeout>;
    const setTimer = vi.fn(() => token);
    const clearTimer = vi.fn();
    const worker = new PinboardSeederWorker(
      { pool: fakePool, logger: log, signer: fakeSigner, seedFn, setTimer, clearTimer },
      4,
    );
    await worker.start();
    await new Promise((r) => setTimeout(r, 0));
    worker.stop();
    expect(clearTimer).toHaveBeenCalledWith(token);
  });

  it('does not overlap runs — a second start() during an in-flight run is a no-op', async () => {
    const log = mkLogger();
    let resolveFirst!: (v: SeedResult) => void;
    const seedFn = vi.fn(
      () => new Promise<SeedResult>((res) => { resolveFirst = res; }),
    );
    const setTimer = vi.fn(() => 0 as unknown as ReturnType<typeof setTimeout>);
    const worker = new PinboardSeederWorker(
      { pool: fakePool, logger: log, signer: fakeSigner, seedFn, setTimer },
      4,
    );
    await worker.start();
    await new Promise((r) => setTimeout(r, 0));
    // Starting again while the first run is in-flight should NOT kick a second seedOnce.
    await worker.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(seedFn).toHaveBeenCalledTimes(1);
    resolveFirst(OK_RESULT);
  });
});
