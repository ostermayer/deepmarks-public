import 'dotenv/config';
import { copyFileSync, chmodSync } from 'node:fs';
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

function urls(name: string, def = ''): string[] {
  const raw = process.env[name] ?? def;
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
    .map((url) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') throw new Error('must be https');
        return parsed.toString().replace(/\/$/, '');
      } catch {
        // eslint-disable-next-line no-console
        console.error(`fatal: env var ${name} contains an invalid Blossom URL: ${url}`);
        process.exit(1);
      }
    });
}

const config: WorkerConfig = {
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  blossomPrimaryUrl: process.env.BLOSSOM_PRIMARY_URL ?? 'https://blossom.deepmarks.org',
  blossomMirrorUrls: urls('BLOSSOM_MIRROR_URLS'),
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
  archiveAuditIntervalMs: num('ARCHIVE_AUDIT_INTERVAL_MS', 10 * 60_000),
  archiveAuditStaleAfterSeconds: num('ARCHIVE_AUDIT_STALE_AFTER_SECONDS', 2 * 60 * 60),
  archiveAuditMaxJobsPerPass: num('ARCHIVE_AUDIT_MAX_JOBS', 1_000),
  archiveAuditMaxRuntimeMs: num('ARCHIVE_AUDIT_MAX_RUNTIME_MS', 4 * 60_000),
  mediaArchiveMaxBytes: num('MEDIA_ARCHIVE_MAX_BYTES', 2 * 1024 * 1024 * 1024),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};

// yt-dlp rewrites the cookie jar after use, so it needs a WRITABLE cookies
// file in a writable directory. The operator's cookies are mounted read-only
// on a read-only rootfs, so stage a copy into the writable tmpfs at boot and
// point yt-dlp at that. The operator's file stays pristine; refreshes live for
// the container's lifetime (the operator re-exports on expiry anyway).
function stageYtDlpCookies(): void {
  const src = process.env.YTDLP_COOKIES_FILE?.trim();
  if (!src || src.startsWith('/tmp/')) return;
  const dst = '/tmp/yt-cookies.txt';
  try {
    copyFileSync(src, dst);
    chmodSync(dst, 0o600);
    process.env.YTDLP_COOKIES_FILE = dst;
    // eslint-disable-next-line no-console
    console.log(`staged yt-dlp cookies to ${dst}`);
  } catch (err) {
    // Can't stage (missing/unreadable mount) — run without cookies rather than
    // crashing yt-dlp on the read-only file. YouTube bot-wall failures then
    // fire the cookie-refresh alert.
    delete process.env.YTDLP_COOKIES_FILE;
    // eslint-disable-next-line no-console
    console.error('could not stage yt-dlp cookies; running without:', (err as Error).message);
  }
}
stageYtDlpCookies();

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
