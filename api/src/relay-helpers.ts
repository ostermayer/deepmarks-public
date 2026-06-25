// Tiny shared helpers used by the relay-fanout worker, onboarding
// scanner, follows-ingester, and lifetime-archive backfill. Each was
// reimplementing the same two utilities; pulling them here removes
// drift between copies (e.g. a fix to relay-URL normalization that
// only landed in one place).

import type { SimplePool, Event as NostrEvent } from 'nostr-tools';
import WebSocket from 'ws';

/**
 * Issue a REQ to the given relays, collect events until every relay
 * EOSEs/closes or `timeoutMs`, and return them. Never throws — a
 * relay error or malformed frame is ignored. The `_pool` argument is
 * kept for existing worker call sites; this helper intentionally uses
 * raw guarded WebSocket parsing so malformed third-party relay frames
 * cannot crash api through nostr-tools internals.
 */
export function queryWithTimeout(
  _pool: SimplePool,
  relays: string[],
  filter: Record<string, unknown>,
  timeoutMs: number,
): Promise<NostrEvent[]> {
  const out: NostrEvent[] = [];
  return new Promise((resolve) => {
    const sockets = new Set<WebSocket>();
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const socket of sockets) {
        try { socket.close(); } catch { /* already closed */ }
      }
      resolve(out);
    };
    const timer = setTimeout(finish, timeoutMs);

    const subId = `dm-${Math.random().toString(36).slice(2)}`;
    let pending = 0;
    for (const relay of Array.from(new Set(relays))) {
      let socket: WebSocket;
      try {
        socket = new WebSocket(relay);
      } catch {
        continue;
      }
      pending += 1;
      sockets.add(socket);

      const markDone = (): void => {
        if (settled) return;
        if (sockets.delete(socket)) {
          try { socket.close(); } catch { /* already closed */ }
          pending -= 1;
          if (pending <= 0) finish();
        }
      };

      socket.on('open', () => {
        try {
          socket.send(JSON.stringify(['REQ', subId, filter]));
        } catch {
          markDone();
        }
      });
      socket.on('message', (data) => {
        const msg = parseRelayMessage(data, subId);
        if (msg?.type === 'event') {
          out.push(msg.event);
        } else if (msg?.type === 'done') {
          markDone();
        }
      });
      socket.on('error', markDone);
      socket.on('close', markDone);
    }

    if (pending === 0) {
      finish();
    }
  });
}

export function parseRelayMessage(
  data: WebSocket.RawData | string,
  subId: string,
): { type: 'event'; event: NostrEvent } | { type: 'done' } | null {
  try {
    const text = typeof data === 'string'
      ? data
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString('utf8')
            : null;
    if (!text) return null;
    const msg = JSON.parse(text);
    if (!Array.isArray(msg) || msg[1] !== subId) return null;
    if (msg[0] === 'EVENT' && isNostrEvent(msg[2])) {
      return { type: 'event', event: msg[2] };
    }
    if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') return { type: 'done' };
    return null;
  } catch {
    return null;
  }
}

function isNostrEvent(value: unknown): value is NostrEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<NostrEvent>;
  return (
    typeof event.id === 'string' &&
    typeof event.pubkey === 'string' &&
    typeof event.created_at === 'number' &&
    typeof event.kind === 'number' &&
    Array.isArray(event.tags) &&
    typeof event.content === 'string' &&
    typeof event.sig === 'string'
  );
}

/**
 * Tighten + sanity-check a relay URL string for use as an outbound
 * target. Returns null if the URL is junk we should never connect to
 * (single-label host, IP literal, localhost, non-wss(?) scheme).
 *
 * Same rules across every worker that fans out to user-supplied
 * relay URLs (relay-fanout, follows-ingester). Without a single
 * implementation it's easy for one of those workers to drift —
 * e.g. accept `ws://localhost/` because someone forgot the
 * localhost guard.
 */
export function normalizeRelayUrl(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^wss?:\/\//i.test(trimmed)) return null;
  let u: URL;
  try { u = new URL(trimmed); }
  catch { return null; }
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost') return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  // 'strfry' is the docker-internal alias for our own relay — allow
  // it through so the workers can route to ws://strfry:7777. Anything
  // else without a dot is rejected (intranet-only hosts can't be
  // reached from Box A anyway).
  if (!host.includes('.') && host !== 'strfry') return null;
  const port = u.port ? `:${u.port}` : '';
  return `${u.protocol}//${host}${port}${u.pathname.replace(/\/$/, '')}`;
}
