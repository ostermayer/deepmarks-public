import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import type { Deps } from '../route-deps.js';

const BLOSSOM_PUBLIC_BASE = 'https://blossom.deepmarks.org';
const BLOSSOM_AUTH_KIND = 24242;
const MAX_AUTH_FUTURE_SECONDS = 10 * 60;

export interface BlossomAuthCheckResult {
  ok: boolean;
  pubkey?: string;
  reason?: string;
}

export function verifyBlossomAuthHeader(
  authHeader: string | undefined,
  opts: { method?: string; serverUrl?: string; now?: number } = {},
): BlossomAuthCheckResult {
  if (!authHeader) return { ok: false, reason: 'missing Authorization header' };
  const match = /^Nostr\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return { ok: false, reason: 'malformed Authorization header' };

  let event: NostrEvent;
  try {
    event = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as NostrEvent;
  } catch {
    return { ok: false, reason: 'unparseable auth event' };
  }

  if (event.kind !== BLOSSOM_AUTH_KIND) return { ok: false, reason: 'wrong kind' };
  if (!/^[0-9a-f]{64}$/i.test(event.pubkey)) return { ok: false, reason: 'invalid pubkey' };
  if (!verifyEvent(event)) return { ok: false, reason: 'bad signature' };

  const action = event.tags.find((t) => t[0] === 't')?.[1];
  const method = opts.method?.toUpperCase();
  if (method === 'DELETE') {
    if (action !== 'delete') return { ok: false, reason: 'delete auth requires t=delete' };
  } else if (method === 'PUT' || method === 'POST') {
    if (action !== 'upload' && action !== 'mirror') {
      return { ok: false, reason: 'write auth requires t=upload or t=mirror' };
    }
  } else if (action !== 'upload' && action !== 'mirror' && action !== 'delete') {
    return { ok: false, reason: 'unsupported blossom action' };
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const expirationRaw = event.tags.find((t) => t[0] === 'expiration')?.[1];
  const expiration = expirationRaw ? Number.parseInt(expirationRaw, 10) : NaN;
  if (!Number.isFinite(expiration)) return { ok: false, reason: 'missing expiration tag' };
  if (expiration <= now) return { ok: false, reason: 'auth event expired' };
  if (expiration > now + MAX_AUTH_FUTURE_SECONDS) {
    return { ok: false, reason: 'expiration is too far in the future' };
  }

  const serverTag = event.tags.find((t) => t[0] === 'server')?.[1]?.replace(/\/$/, '');
  const expectedServer = opts.serverUrl?.replace(/\/$/, '');
  if (serverTag && expectedServer && serverTag !== expectedServer) {
    return { ok: false, reason: 'server tag does not match blossom.deepmarks.org' };
  }

  return { ok: true, pubkey: event.pubkey.toLowerCase() };
}

export function register(deps: Deps): void {
  const {
    app,
    ARCHIVE_WORKER_PUBKEY,
  } = deps;

  app.get('/blossom/check-auth', async (request, reply) => {
    if (!ARCHIVE_WORKER_PUBKEY) {
      return reply.status(503).send({ error: 'archive worker pubkey is not configured' });
    }
    const authCheck = verifyBlossomAuthHeader(
      Array.isArray(request.headers.authorization)
        ? request.headers.authorization[0]
        : request.headers.authorization,
      {
        method: (request.headers['x-forwarded-method'] ?? request.headers['x-original-method'])?.toString(),
        serverUrl: BLOSSOM_PUBLIC_BASE,
      },
    );
    if (!authCheck.ok || !authCheck.pubkey) {
      return reply.status(401).send({ error: authCheck.reason ?? 'invalid blossom auth' });
    }

    if (authCheck.pubkey === ARCHIVE_WORKER_PUBKEY) {
      return { ok: true, pubkey: authCheck.pubkey, via: 'archive-worker' };
    }
    return reply.status(403).send({ error: 'Blossom writes are restricted to Deepmarks archive workers' });
  });
}
