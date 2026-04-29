import 'dotenv/config';
import { Worker, type WorkerConfig } from './worker.js';

/**
 * Archive worker entrypoint. Reads config from env, starts the worker,
 * handles graceful shutdown on SIGINT/SIGTERM.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    // eslint-disable-next-line no-console
    console.error(`fatal: env var ${name} is required`);
    process.exit(1);
  }
  return v;
}

function num(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    // eslint-disable-next-line no-console
    console.error(`fatal: env var ${name} must be a number, got ${raw}`);
    process.exit(1);
  }
  return parsed;
}

const config: WorkerConfig = {
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  blossomPrimaryUrl: process.env.BLOSSOM_PRIMARY_URL ?? 'https://blossom.deepmarks.org',
  workerNsec: required('ARCHIVE_WORKER_NSEC'),
  paymentProxyUrl: process.env.PAYMENT_PROXY_URL ?? 'http://payment-proxy:4000',
  workerCallbackSecret: required('WORKER_CALLBACK_SECRET'),
  waybackMaxAgeDays: num('WAYBACK_MAX_AGE_DAYS', 90),
  playwrightNavTimeoutMs: num('PLAYWRIGHT_NAV_TIMEOUT_MS', 30_000),
  playwrightRenderTimeoutMs: num('PLAYWRIGHT_RENDER_TIMEOUT_MS', 60_000),
  playwrightViewport: process.env.PLAYWRIGHT_VIEWPORT ?? '1280x800',
  heartbeatIntervalMs: num('WORKER_HEARTBEAT_INTERVAL_MS', 10_000),
  stagedBlobTtlSeconds: num('STAGED_BLOB_TTL_SECONDS', 900),
  maxConcurrentJobs: num('MAX_CONCURRENT_JOBS', 4),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};

const worker = new Worker(config);

const shutdown = async (signal: string): Promise<void> => {
  // eslint-disable-next-line no-console
  console.log(`received ${signal}, shutting down`);
  await worker.shutdown();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

worker.start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal startup error:', err);
  process.exit(1);
});
