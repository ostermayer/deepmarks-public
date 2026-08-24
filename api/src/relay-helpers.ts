// Tiny shared helpers used by the relay-fanout worker, onboarding
// scanner, follows-ingester, and lifetime-archive backfill. Each was
// reimplementing the same two utilities; pulling them here removes
// drift between copies (e.g. a fix to relay-URL normalization that
// only landed in one place).

import type { SimplePool, Event as NostrEvent, Filter } from 'nostr-tools';
import WebSocket from 'ws';

/**
 * Lifetime single-relay subscription for the workers that watch our
 * own strfry.
 *
 * Deliberately NOT SimplePool.subscribeMany: its cross-relay dedup
 * keeps every event id it has ever seen in a per-subscription Set, and
 * each id is a V8 sliced string into the FULL raw relay frame
 * (nostr-tools getHex64 slices the id out of the incoming message
 * before JSON.parse), so the Set pins every frame ever received. A
 * kind:3 contact-list frame runs 100–250KB; the relay-sync worker
 * accumulated pinned frames to the 2GB heap cap and crash-looped
 * (2026-07-27 incident). With exactly one relay there is nothing to
 * dedup — subscribing at the relay level keeps the id slice transient
 * and lets the frame be collected.
 *
 * Connects in the background and retries until the relay accepts, so a
 * worker that boots before strfry is reachable still gets its
 * subscription (subscribeMany silently gave up after one failed
 * attempt). Once connected, nostr-tools AbstractRelay re-establishes
 * dropped connections itself and re-fires open subscriptions with
 * since = last-emitted + 1.
 */
export function subscribeSingleRelay(
  pool: SimplePool,
  url: string,
  filters: Filter[],
  params: { onevent: (event: NostrEvent) => void },
  opts: {
    logError?: (obj: Record<string, unknown>, msg: string) => void;
    retryDelayMs?: number;
  } = {},
): { close: () => void } {
  let closed = false;
  let sub: { close: () => void } | undefined;
  const retryDelayMs = opts.retryDelayMs ?? 5_000;
  void (async () => {
    while (!closed) {
      try {
        const relay = await pool.ensureRelay(url);
        if (closed) return;
        sub = relay.subscribe(filters, params);
        return;
      } catch (err) {
        opts.logError?.({ err, url }, 'single-relay subscribe failed — retrying');
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  })();
  return {
    close: () => {
      closed = true;
      sub?.close();
    },
  };
}

/**
 * Issue a REQ to the given relays, collect events until every relay
 * EOSEs/closes or `timeoutMs`, and return them. Never throws — a
 * relay error or malformed frame is ignored. This helper intentionally
 * uses raw guarded WebSocket parsing (no SimplePool) so malformed
 * third-party relay frames cannot crash api through nostr-tools
 * internals.
 */
export function queryWithTimeout(
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
