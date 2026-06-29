// Standalone logger for worker processes.
//
// In the single-process (RUN_WORKERS=all) deployment the workers borrow
// the Fastify app's `app.log`. When a worker group runs in its own
// process there's no Fastify instance, so we build a bare pino logger
// configured identically to `index.ts` (JSON in production, pino-pretty
// in dev). pino is the same logger Fastify uses under the hood, so
// `WorkerLogger` is structurally identical to `app.log` and the two are
// freely interchangeable in `workers-bootstrap.ts` / `invoice-handler.ts`.

import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';

/** The logger shape workers accept. This is exactly Fastify's `app.log`
 *  type so the two are interchangeable: the API passes `app.log` when it
 *  runs workers in-process, and a standalone worker passes a bare pino
 *  logger (which is assignable to FastifyBaseLogger). Downstream helpers
 *  like settleArchivePurchase already type their `log` param this way. */
export type WorkerLogger = FastifyBaseLogger;

/** Build a pino logger for a worker process. `name` is attached as a
 *  base field so log lines are attributable to the worker group. */
export function createWorkerLogger(name: string): WorkerLogger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true } },
  });
}
