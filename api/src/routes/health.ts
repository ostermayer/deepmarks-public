// /health — boot/uptime probe. Returns the LN address + signer pubkeys
// so an operator can confirm the server is talking to the right Voltage
// node and the right Box C bunker.

import type { Deps } from '../route-deps.js';
import { collectArchiveHealth } from '../archive-health.js';

export function register(deps: Deps): void {
  const { app, redis, signers, LN_ADDRESS } = deps;

  app.get('/health', async () => ({
    ok: true,
    ts: Date.now(),
    lnAddress: LN_ADDRESS,
    brandPubkey: signers.brand.pubkey,
    personalPubkey: signers.personal.pubkey,
  }));

  // Relay WRITE-path health. Every other probe is read-only — a wedged
  // write pipeline (LMDB map full, dead worker, rejecting policy) stays
  // green on all of them while every save silently queues forever. The
  // uptime checker alerts on wedged=true.
  app.get('/health/relay', async (_req, reply) => {
    const [queueLen, deadLen, delayedLen, lastForwardRaw] = await Promise.all([
      redis.llen('dm:publish-relay:queue').catch(() => -1),
      redis.llen('dm:publish-relay:dead').catch(() => -1),
      redis.zcard('dm:publish-relay:delayed').catch(() => -1),
      redis.get('dm:publish-relay:last-forward-ts').catch(() => null),
    ]);
    const lastForwardAt = lastForwardRaw ? Number(lastForwardRaw) : null;
    const staleMs = lastForwardAt ? Date.now() - lastForwardAt : null;
    // Wedged = work is waiting but nothing has been forwarded for 15 min.
    const wedged = queueLen > 0 && (staleMs === null || staleMs > 15 * 60_000);
    if (wedged) reply.status(503);
    return {
      ok: !wedged,
      wedged,
      queue: queueLen,
      delayed: delayedLen,
      deadLettered: deadLen,
      lastForwardAt,
    };
  });

  // Archive pipeline health. This is stronger than a process liveness
  // check: it also sees old pending jobs, in-flight jobs whose worker
  // heartbeat disappeared, and stale/erroring audit passes.
  app.get('/health/archive', async (_req, reply) => {
    const health = await collectArchiveHealth(redis);
    if (!health.ok) reply.status(503);
    reply.header('cache-control', 'no-store');
    return health;
  });
}
