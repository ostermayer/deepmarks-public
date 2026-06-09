// Factories for the per-request auth gates routes use.
//
// These build closures over `redis` (for NIP-98 replay dedup) and the
// admin pubkey set so route modules just call `deps.requireNip98(...)`
// or `deps.requireAdmin(...)` without re-plumbing the underlying state.

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { verifyNip98, type Nip98VerifyResult } from '../auth.js';
import { recordAuthenticatedPubkey } from '../registry.js';

export type Nip98Fn = (
  authHeader: string | undefined,
  expectedUrl: string,
  expectedMethod: string,
  body?: Buffer,
) => Promise<Nip98VerifyResult>;

/** NIP-98 wrapper that binds redis (for replay dedup) and accepts an
 *  optional rawBody to enforce body-hash binding via the `payload` tag.
 *  All routes call this instead of verifyNip98 directly so the replay
 *  window can't be missed by a copy-paste of the older 3-arg form. */
export function makeNip98(redis: Redis): Nip98Fn {
  return (authHeader, expectedUrl, expectedMethod, body) =>
    verifyNip98(authHeader, expectedUrl, expectedMethod, { redis, body });
}

/**
 * Combined NIP-98 verification + 401 short-circuit. Routes call this
 * once; if it returns null, they `return;` — no need to write the
 * `if (!authCheck.ok) return reply.status(401)…` boilerplate. Pass
 * `bindBody: true` on body-bearing routes so the auth event is bound
 * to sha256(rawBody) via the NIP-98 `payload` tag (defends against
 * captured-header replay against attacker-chosen bytes).
 */
export type RequireNip98Fn = (
  request: FastifyRequest,
  reply: FastifyReply,
  expectedUrl: string,
  expectedMethod: string,
  opts?: { bindBody?: boolean },
) => Promise<{ pubkey: string } | null>;

export function makeRequireNip98(nip98: Nip98Fn, redis: Redis): RequireNip98Fn {
  return async function requireNip98(
    request: FastifyRequest,
    reply: FastifyReply,
    expectedUrl: string,
    expectedMethod: string,
    opts: { bindBody?: boolean } = {},
  ): Promise<{ pubkey: string } | null> {
    const result = await nip98(
      request.headers.authorization,
      expectedUrl,
      expectedMethod,
      opts.bindBody ? (request as { rawBody?: Buffer }).rawBody : undefined,
    );
    if (!result.ok || !result.pubkey) {
      reply.status(401).send({ error: result.reason ?? 'unauthorized' });
      return null;
    }
    // Any pubkey that successfully proves possession of its key to us
    // is by definition a Deepmarks user. Record the activity so their
    // events can flow through the relay's writePolicy and so their
    // third-party NIP-51 bookmarks are refreshed in the background.
    void recordAuthenticatedPubkey(redis, result.pubkey);
    return { pubkey: result.pubkey };
  };
}

/** Build a `requireAdmin` closure bound to nip98 + the admin pubkey set
 *  + the `requireAdmin` rate-limit bucket. Returns the same shape the
 *  original index.ts version returned. */
export type RequireAdminFn = (
  request: { headers: { authorization?: string }; url: string; method: string; rawBody?: Buffer },
) => Promise<{ ok: true; pubkey: string } | { ok: false; reason: string; status?: number }>;

export function makeRequireAdmin(opts: {
  nip98: Nip98Fn;
  publicBaseUrl: string;
  adminPubkeys: Set<string>;
  redis: Redis;
  rateLimit: (
    bucket: string,
    key: string,
    limit: number,
    windowSeconds: number,
  ) => Promise<{ ok: true } | { ok: false; retryAfter: number }>;
}): RequireAdminFn {
  return async function requireAdmin(
    request: { headers: { authorization?: string }; url: string; method: string; rawBody?: Buffer },
  ): Promise<{ ok: true; pubkey: string } | { ok: false; reason: string; status?: number }> {
    // Bind the auth event to this exact body (when present). Without
    // this, a captured admin Authorization header could be replayed
    // within the freshness window against attacker-chosen bytes —
    // minting lifetime grants for arbitrary pubkeys via
    // /admin/lifetime/stamp, etc. The replay-id dedup blocks the exact
    // same event id but a single capture-then-replay-once-with-new-body
    // would otherwise win.
    const check = await opts.nip98(
      request.headers.authorization,
      `${opts.publicBaseUrl}${request.url}`,
      request.method,
      request.rawBody,
    );
    if (!check.ok || !check.pubkey) return { ok: false, reason: check.reason ?? 'unauthorized' };
    if (!opts.adminPubkeys.has(check.pubkey)) return { ok: false, reason: 'not an admin' };
    // Admin auth implies the admin pubkey is a registered Deepmarks
    // user — keep the relay's writePolicy happy when ops send events
    // via the admin pubkey, and apply the same background import path.
    void recordAuthenticatedPubkey(opts.redis, check.pubkey);
    // Per-admin-pubkey rate limit. Stops a leaked admin auth header
    // from being brute-forced against many targets, and is a guardrail
    // against a misconfigured admin client looping on a paginated op
    // like /admin/lifetime/reconcile.
    const gate = await opts.rateLimit('admin-pk', check.pubkey, 30, 60);
    if (!gate.ok) return { ok: false, reason: `rate limit (admin)`, status: 429 };
    return { ok: true, pubkey: check.pubkey };
  };
}
