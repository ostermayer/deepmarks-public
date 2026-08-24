import { createHash } from 'node:crypto';
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import type { Redis } from 'ioredis';

// The email-session JWT machinery (SessionClaims / issueSessionToken /
// verifySessionToken) lived here until 2026-08-23. It was the orphaned
// half of the email/magic-link login removed when passkey storage
// shipped (docs/login.md) — no account records existed, so no token
// could ever validate. Removed with the rest of the email-era surface;
// see docs/robustness-review-2026-08-23.md.

/**
 * NIP-98 HTTP auth: client signs a kind:27235 event that includes the
 * request URL and method. We verify the signature, the event's freshness,
 * and that URL/method match.
 *
 * Used by every authenticated route (account/archives, settings,
 * passkey, ciphertext, publish, archive enqueue — wired through
 * helpers/auth-gate.ts) as proof of nsec possession.
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
