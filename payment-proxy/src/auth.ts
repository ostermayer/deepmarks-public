import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import type { Redis } from 'ioredis';

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface SessionClaims {
  pubkey: string;
  emailHash: string;
  sessionVersion: number;
  tier: 'email' | 'full';
  iat: number;
  exp: number;
}

export function issueSessionToken(
  pubkey: string,
  emailHash: string,
  sessionVersion: number,
  tier: 'email' | 'full',
): string {
  const secret = requireEnv('JWT_SECRET');
  const now = Math.floor(Date.now() / 1000);
  const claims: SessionClaims = {
    pubkey,
    emailHash,
    sessionVersion,
    tier,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  return jwt.sign(claims, secret, { algorithm: 'HS256' });
}

export function verifySessionToken(token: string): SessionClaims | null {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }) as SessionClaims;
    if (!decoded.pubkey || !/^[0-9a-f]{64}$/.test(decoded.pubkey)) return null;
    if (!decoded.emailHash || typeof decoded.sessionVersion !== 'number') return null;
    // Validate tier against the closed set rather than trusting whatever
    // string lands in the JWT. Without this an unrecognized tier value
    // (a future deploy that introduced 'admin' but rolled back, a bad
    // re-issue script) would silently authenticate as something the
    // permission code didn't anticipate.
    if (decoded.tier !== 'email' && decoded.tier !== 'full') return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * NIP-98 HTTP auth: client signs a kind:27235 event that includes the
 * request URL and method. We verify the signature, the event's freshness,
 * and that URL/method match.
 *
 * Used for write operations (private-bookmark upload, email linking)
 * where we need proof of nsec possession, not just a session cookie.
 *
 * Header format:  Authorization: Nostr <base64-json-event>
 */
export interface Nip98VerifyResult {
  ok: boolean;
  pubkey?: string;
  reason?: string;
}

export interface Nip98VerifyOptions {
  /** When provided, dedup by event.id with a 65s TTL — blocks replay
   *  of a captured Authorization header within the freshness window. */
  redis?: Redis;
  /** Raw request body. When provided, the auth event MUST carry a
   *  `payload` tag equal to its sha256 hex. Without this binding, a
   *  captured POST header could be replayed against a different body. */
  body?: Buffer | string;
}

export async function verifyNip98(
  authHeader: string | undefined,
  expectedUrl: string,
  expectedMethod: string,
  opts: Nip98VerifyOptions = {},
): Promise<Nip98VerifyResult> {
  if (!authHeader) return { ok: false, reason: 'missing Authorization header' };

  const match = /^Nostr\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return { ok: false, reason: 'malformed Authorization header' };

  let event: NostrEvent;
  try {
    const json = Buffer.from(match[1], 'base64').toString('utf8');
    event = JSON.parse(json) as NostrEvent;
  } catch {
    return { ok: false, reason: 'unparseable auth event' };
  }

  if (event.kind !== 27235) return { ok: false, reason: 'wrong kind (must be 27235)' };
  if (!verifyEvent(event)) return { ok: false, reason: 'bad signature' };

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created_at) > 60) {
    return { ok: false, reason: 'auth event is stale or from the future (>60s skew)' };
  }

  const uTag = event.tags.find((t) => t[0] === 'u')?.[1];
  const methodTag = event.tags.find((t) => t[0] === 'method')?.[1];

  if (uTag !== expectedUrl) return { ok: false, reason: 'u tag does not match request URL' };
  if (methodTag?.toUpperCase() !== expectedMethod.toUpperCase()) {
    return { ok: false, reason: 'method tag does not match request' };
  }

  // Body-binding: per NIP-98, a `payload` tag holds sha256(body) for
  // body-bearing requests. We require it whenever the route passes the
  // body in. A captured POST header without this can otherwise be
  // replayed against attacker-chosen bytes within the 60s skew window.
  if (opts.body !== undefined) {
    const expectedHash = createHash('sha256')
      .update(typeof opts.body === 'string' ? Buffer.from(opts.body, 'utf8') : opts.body)
      .digest('hex');
    const payloadTag = event.tags.find((t) => t[0] === 'payload')?.[1]?.toLowerCase();
    if (!payloadTag) return { ok: false, reason: 'missing payload tag for body-bearing request' };
    if (payloadTag !== expectedHash) return { ok: false, reason: 'payload tag does not match body hash' };
  }

  // Replay defence: single-use the event id within the freshness window.
  if (opts.redis && event.id) {
    const set = await opts.redis.set(`dm:nip98:${event.id}`, '1', 'EX', 65, 'NX');
    if (set !== 'OK') return { ok: false, reason: 'auth event replay rejected' };
  }

  return { ok: true, pubkey: event.pubkey };
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return v;
}
