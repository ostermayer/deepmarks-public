// Load `.env` before any module reads process.env. In production, env vars
// come from Docker / systemd and this call is a no-op.
import 'dotenv/config';

import Fastify from 'fastify';
import cors from '@fastify/cors';

import { buildDeps, envCorsOrigin, envPublicBaseUrl } from './bootstrap.js';
import { attachInvoiceHandler } from './invoice-handler.js';
import { feedDepsFromEnv, registerFeedRoutes } from './feed/routes.js';
import { buildWorkers, startWorkers, recoverLifetimeLabels } from './workers-bootstrap.js';

import * as health from './routes/health.js';
import * as favicon from './routes/favicon.js';
import * as metadata from './routes/metadata.js';
import * as archive from './routes/archive.js';
import * as lnurl from './routes/lnurl.js';
import * as account from './routes/account.js';
import * as passkey from './routes/passkey.js';
import * as ciphertext from './routes/ciphertext.js';
import * as lifetime from './routes/lifetime.js';
import * as privateMarks from './routes/private-marks.js';
import * as reports from './routes/reports.js';
import * as relayChecks from './routes/relay-checks.js';
import * as admin from './routes/admin.js';
import * as search from './routes/search.js';
import * as apiV1 from './routes/api-v1.js';

const PORT = Number.parseInt(process.env.PORT ?? '4000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

/** Collapse a request URL into a stable alert-dedup key — strips the
 *  query string, replaces hex segments (event ids, payment hashes,
 *  pubkeys) with a placeholder so a 5xx loop on /archive/status/<hash>
 *  doesn't fan out to N keys, one per hash. */
function routeKey(url: string): string {
  const path = url.split('?')[0] ?? '/';
  return path
    .split('/')
    .map((seg) => /^[0-9a-f]{16,}$/i.test(seg) ? ':hex' : seg)
    .join('/');
}

async function start(): Promise<void> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true } },
    },
    trustProxy: true,
  });

  // Boot-time sanity check on CORS_ORIGIN — must be non-empty so
  // browser callers from the frontend can reach this API at all.
  // The previous predicate compared CORS_ORIGIN to PUBLIC_BASE_URL's
  // host, but that's the WRONG comparison: CORS_ORIGIN lists the
  // browser-side origins allowed to make cross-origin requests, while
  // PUBLIC_BASE_URL is this API's own host. They're supposed to differ
  // (frontend at deepmarks.org calls api.deepmarks.org). The old check
  // logged a confusing 'NIP-98 routes likely 401' warning on every boot
  // even though everything worked.
  const PUBLIC_BASE_URL = envPublicBaseUrl();
  const CORS_ORIGIN = envCorsOrigin();
  if (CORS_ORIGIN.length === 0) {
    app.log.warn(
      { PUBLIC_BASE_URL },
      'CORS_ORIGIN is empty — browser-side callers will be blocked. Set CORS_ORIGIN to the frontend origin (e.g. https://deepmarks.org).',
    );
  } else {
    for (const o of CORS_ORIGIN) {
      try { new URL(o); }
      catch {
        app.log.warn({ origin: o }, 'CORS_ORIGIN entry is not a valid URL — fastify-cors will reject it');
      }
    }
  }
  try { new URL(PUBLIC_BASE_URL); }
  catch { app.log.warn({ PUBLIC_BASE_URL }, 'PUBLIC_BASE_URL is not a valid URL'); }

  await app.register(cors, {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
  });

  // Replace the default JSON parser so we keep the raw bytes around for
  // signature verification (BTCPay HMAC). `request.body` is still the
  // parsed object; downstream routes don't change.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      (request as { rawBody?: Buffer }).rawBody = body;
      if (body.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Build the shared dependency container, the lightning invoice
  // listener, and the long-running background workers. Each is wired
  // up here but the workers don't start until after `app.listen`.
  const deps = await buildDeps(app);

  // Generic 5xx handler — log the cause, return a sterile body, and
  // alert the operator. Registered AFTER buildDeps so `deps.alerter`
  // is in scope (the handler runs at request time, not registration
  // time, but referencing deps.alerter inside requires deps to be
  // declared by then). Without this handler, Fastify's default would
  // leak stack traces to clients (worse with trustProxy:true). Doesn't
  // fire on routes that explicitly reply.status(...) — only catches
  // uncaught throws.
  app.setErrorHandler((err, request, reply) => {
    request.log.error({ err, url: request.url, method: request.method }, 'unhandled route error');
    if (reply.sent) return;
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    reply.status(status).send({ error: status >= 500 ? 'internal error' : (e.message ?? 'error') });
    // Email the operator on uncaught 5xx — debouncing in the alerter
    // collapses bursts (a busted dependency hammering one route would
    // otherwise email a hundred times in a minute). Per-route key so
    // a flapping /metadata doesn't suppress unrelated /archive errors.
    if (status >= 500) {
      void deps.alerter.alert({
        severity: 'critical',
        key: `unhandled:${request.method}:${routeKey(request.url)}`,
        subject: `unhandled ${status} on ${request.method} ${request.url}`,
        body: [
          `Method: ${request.method}`,
          `URL: ${request.url}`,
          `Status: ${status}`,
          `Error: ${(err as Error).message ?? '(no message)'}`,
          (err as Error).stack ? `Stack:\n${(err as Error).stack}` : '',
        ].filter(Boolean).join('\n'),
      });
    }
  });

  const invoiceSub = attachInvoiceHandler(deps);
  const workers = buildWorkers(deps);

  // ─── Atom feeds: /feed/{recent,network,popular,tags/:tag,user/:npub}.xml ─
  registerFeedRoutes(app, {
    ...feedDepsFromEnv(deps.relayPool),
    resolveUsername: (name) => deps.usernameStore.lookup(name),
  });

  // ─── Per-domain route modules ───────────────────────────────────────
  health.register(deps);
  favicon.register(deps);
  metadata.register(deps);
  archive.register(deps);
  lnurl.register(deps);
  account.register(deps);
  passkey.register(deps);
  ciphertext.register(deps);
  lifetime.register(deps);
  privateMarks.register(deps);
  reports.register(deps);
  relayChecks.register(deps);
  admin.register(deps);
  search.register(deps);
  apiV1.register(deps);

  // ─── Start ──────────────────────────────────────────────────────────
  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info({ lnAddress: deps.LN_ADDRESS, port: PORT }, 'payment proxy listening');
    startWorkers(deps, workers);
    recoverLifetimeLabels(deps);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      invoiceSub?.removeAllListeners();
      workers.pinboardSeeder.stop();
      await Promise.allSettled([
        workers.indexer.stop(),
        workers.zapListener.stop(),
        workers.saveCountTracker.stop(),
        workers.profileResolver.stop(),
      ]);
      await app.close();
      deps.relayPool.close([]);
      deps.redis.disconnect();
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal startup error', err);
  process.exit(1);
});
