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

  // Primary Blossom liveness. The public origin can't be probed at / —
  // Caddy serves a static landing page there that stays green with the
  // blossom-server container dead — so ask the container directly over
  // the compose network. Any HTTP answer below 500 counts as alive: the
  // point is "process up and speaking HTTP", not auth or data-path
  // semantics (data-path trouble surfaces as job failures + archive
  // health). Probed by deepmarks-uptime-check from Box C.
  // `|| fallback`, not `??`: compose passes BLOSSOM_HEALTH_URL through as
  // an EMPTY STRING when unset (`${VAR:-}` explicit-list pattern), which
  // `??` happily keeps.
  const blossomHealthUrl = (process.env.BLOSSOM_HEALTH_URL ?? '').trim() || 'http://blossom-server:3000/';
  app.get('/health/blossom', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      const res = await fetch(blossomHealthUrl, {
        signal: AbortSignal.timeout(5_000),
        redirect: 'manual',
      });
      const ok = res.status < 500;
      if (!ok) reply.status(503);
      return { ok, upstreamStatus: res.status };
    } catch (err) {
      reply.status(503);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
