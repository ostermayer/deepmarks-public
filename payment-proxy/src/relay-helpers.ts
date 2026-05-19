// Tiny shared helpers used by the relay-fanout worker, onboarding
// scanner, follows-ingester, and lifetime-archive backfill. Each was
// reimplementing the same two utilities; pulling them here removes
// drift between copies (e.g. a fix to relay-URL normalization that
// only landed in one place).

import type { SimplePool, Event as NostrEvent } from 'nostr-tools';

/**
 * Issue a REQ to the given relays via `pool`, collect events until
 * EOSE or `timeoutMs`, and return them. Never throws — a relay error
 * yields an empty array.
 */
export function queryWithTimeout(
  pool: SimplePool,
  relays: string[],
  filter: Record<string, unknown>,
  timeoutMs: number,
): Promise<NostrEvent[]> {
  const out: NostrEvent[] = [];
  return new Promise((resolve) => {
    let sub: { close: () => void } | null = null;
    const finish = (): void => {
      if (sub) {
        try { sub.close(); } catch { /* relay already closed */ }
        sub = null;
      }
      resolve(out);
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      sub = pool.subscribeMany(relays, filter as never, {
        onevent: (event) => out.push(event),
        oneose: () => { clearTimeout(timer); finish(); },
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
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
