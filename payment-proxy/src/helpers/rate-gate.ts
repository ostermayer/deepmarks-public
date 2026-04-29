// Rate-limit factories shared across route modules.
//
// `makeRateLimit(redis)` returns the raw token-bucket primitive; routes
// that need to make policy decisions on the result use it directly.
// `makeGateRateLimit(rateLimit)` wraps it with a 429-reply short-circuit
// for the common pattern where the route wants to abort on overflow.

import type { FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';

export type RateLimitFn = (
  bucket: string,
  key: string,
  limit: number,
  windowSeconds: number,
) => Promise<{ ok: true } | { ok: false; retryAfter: number }>;

/** Token-bucket rate limit. Returns { ok: true } when allowed,
 *  { ok: false, retryAfter } when the bucket is empty. Generic so
 *  any route can gate on arbitrary keys (IP, pubkey, both). Same
 *  pattern as MetadataStore.rateLimitCheck. */
export function makeRateLimit(redis: Redis): RateLimitFn {
  return async function rateLimit(bucket, key, limit, windowSeconds) {
    const k = `dm:rl:${bucket}:${key}`;
    const count = await redis.incr(k);
    if (count === 1) await redis.expire(k, windowSeconds);
    if (count > limit) {
      const ttl = await redis.ttl(k);
      return { ok: false, retryAfter: ttl > 0 ? ttl : windowSeconds };
    }
    return { ok: true };
  };
}

/**
 * Rate-limit gate that handles its own 429 reply. Returns `true` when
 * the call may proceed, `false` when it shouldn't (the response has
 * already been sent). Caller pattern:
 *
 *   if (!(await gateRateLimit(reply, 'archive-pk', userPubkey, 10, 60))) return;
 */
export type GateRateLimitFn = (
  reply: FastifyReply,
  bucket: string,
  key: string,
  limit: number,
  windowSeconds: number,
) => Promise<boolean>;

export function makeGateRateLimit(rateLimit: RateLimitFn): GateRateLimitFn {
  return async function gateRateLimit(
    reply: FastifyReply,
    bucket: string,
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean> {
    const r = await rateLimit(bucket, key, limit, windowSeconds);
    if (r.ok) return true;
    reply.header('Retry-After', String(r.retryAfter));
    reply.status(429).send({ error: `rate limit (${bucket})`, retryAfter: r.retryAfter });
    return false;
  };
}
