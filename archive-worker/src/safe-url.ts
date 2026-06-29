// SSRF guard for the archive worker. Run before any wayback fetch or
// playwright render. Mirror of api/src/safe-url.ts plus a DNS
// resolve so a hostname like `internal.evil.com → 10.0.0.4` can't sneak
// past the proxy's sync check.
//
// DNS-rebinding defence: `resolveSafePublicUrl` resolves + validates the
// host ONCE, returning the validated DNS answers. `safeFetch` then pins
// one validated address into the connection (via an undici Agent with a
// custom `lookup`), so an attacker flipping the A record between
// validation and the actual TCP/TLS handshake can't steer the fetch at a
// private target. Callers that do their own fetch should migrate to
// `safeFetch` to inherit this pinning.

import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';

export class UnsafeUrlError extends Error {
  constructor(reason: string) {
    super(`unsafe url: ${reason}`);
    this.name = 'UnsafeUrlError';
  }
}

/** Strip surrounding `[...]` from IPv6-literal hostnames so `isIP` sees
 *  the bare address. Matches `api/src/safe-url.ts:normalizeIpLiteralHost`. */
function normalizeIpLiteralHost(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

/** True iff `host` parses as an IPv4 or IPv6 literal. Uses `node:net.isIP`
 *  (strict — rejects hex-looking single labels like `deadbeef`, which the
 *  old `/^[0-9.]+$/ || /^[0-9a-fA-F:]+$/` regex would have wrongly
 *  classified as an IP and then mishandled downstream). Mirrors
 *  `api/src/safe-url.ts:looksLikeIp` so both copies of the guard share
 *  behaviour. */
export function looksLikeIp(host: string): boolean {
  return isIP(normalizeIpLiteralHost(host)) !== 0;
}

export function isPrivateIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number) as [number, number, number, number];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;          // includes 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                         // multicast / reserved
    return false;
  }
  const v6 = (ip.split('%')[0] ?? '').toLowerCase();
  if (v6 === '::1' || v6 === '::' || v6 === '0:0:0:0:0:0:0:1') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true;
  if (v6.startsWith('fe8') || v6.startsWith('fe9') ||
      v6.startsWith('fea') || v6.startsWith('feb')) return true;
  if (v6.startsWith('::ffff:')) {
    const tail = v6.slice('::ffff:'.length);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return isPrivateIp(tail);
  }
  return false;
}

/** Sync + DNS check. Throws UnsafeUrlError on rejection. */
export async function assertSafePublicHttpUrl(raw: string): Promise<URL> {
  return (await resolveSafePublicUrl(raw)).url;
}

interface ResolvedSafeUrl {
  url: URL;
  /** Validated DNS answers for a hostname URL (`verbatim=true` /
   *  `all=true`). Empty for IP-literal URLs — no rebinding possible. */
  addresses: { address: string; family: number }[];
}

/** Validate + DNS-resolve once, returning both the parsed URL and the
 *  validated addresses. Callers that subsequently fetch the URL should
 *  use `safeFetch` (or otherwise pin one of `addresses` into the
 *  connect), otherwise an attacker flipping the host's A record between
 *  this resolve and the actual fetch (TOCTOU window of milliseconds) can
 *  defeat the private-range check. */
async function resolveSafePublicUrl(raw: string | URL): Promise<ResolvedSafeUrl> {
  let parsed: URL;
  if (raw instanceof URL) {
    parsed = raw;
  } else {
    try { parsed = new URL(raw); } catch { throw new UnsafeUrlError('not a valid url'); }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError(`scheme ${parsed.protocol} not allowed`);
  }
  const host = parsed.hostname;
  if (!host) throw new UnsafeUrlError('empty host');
  if (!host.includes('.') && !looksLikeIp(host)) {
    throw new UnsafeUrlError('single-label host disallowed');
  }
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')) {
    throw new UnsafeUrlError(`hostname ${lower} is local`);
  }
  if (looksLikeIp(host)) {
    if (isPrivateIp(host)) throw new UnsafeUrlError(`ip ${host} is private`);
    return { url: parsed, addresses: [] };
  }
  // DNS resolve and reject if ANY result is private. `safeFetch` pins
  // one of these answers into the actual connect so the host's A record
  // can't flip between this validate and the fetch.
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new UnsafeUrlError(`dns lookup failed: ${(err as Error).message}`);
  }
  if (addrs.length === 0) throw new UnsafeUrlError('no dns answers');
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new UnsafeUrlError(`${host} resolves to private ${address}`);
  }
  return { url: parsed, addresses: addrs };
}

type FetchInitLike = Omit<RequestInit, 'dispatcher'>;

/**
 * Validate + fetch in one shot, pinning a validated DNS answer into the
 * connect so an attacker flipping the host's A record between the
 * validate-then-fetch window (DNS rebinding / TOCTOU) can't steer the
 * byte fetch at a private target (Redis, Box C, Linode metadata, …).
 *
 * Hostname URLs go through a per-request undici `Agent` with a custom
 * `lookup` that ignores whatever the OS resolver now returns and returns
 * the address validated upstream. TLS verification still uses
 * `url.hostname` (SNI set by undici), so cert checks are unaffected.
 *
 * For IP-literal URLs no pinning is needed — there is no DNS to rebind —
 * so we fall through to the global `fetch`.
 *
 * Callers that want the redirect-walking behaviour should keep using
 * `resolveSafePublicHttpUrl` (which calls this internally per hop), or
 * pass `redirect: 'manual'` and re-call per hop themselves.
 */
export async function safeFetch(
  input: string | URL,
  init: FetchInitLike = {},
): Promise<Response> {
  const { url, addresses } = await resolveSafePublicUrl(input);
  if (addresses.length === 0) {
    return fetch(url, init);
  }
  const pinned = addresses[0]!;
  const dispatcher = new Agent({
    connect: {
      // Single-shot lookup: ignore the live resolver, always return the
      // address we validated. The Agent closes with the response.
      lookup: (
        _hostname: string,
        _options: unknown,
        callback: (err: Error | null, address: string, family: number) => void,
      ): void => {
        callback(null, pinned.address, pinned.family);
      },
    },
  });
  // The global `fetch` (Node 18+ = undici) accepts a `dispatcher`.
  // `FetchInitLike` omits the field because we own it.
  const fetchInit: FetchInitLike & { dispatcher: unknown } = { ...init, dispatcher };
  try {
    return await fetch(url, fetchInit);
  } finally {
    void dispatcher.close().catch(() => undefined);
  }
}

/**
 * Follow ordinary HTTP redirects manually and validate every hop. This
 * does not replace the host-level egress firewall the worker should run
 * behind, but it blocks the common SSRF shape where a public-looking URL
 * immediately redirects to localhost, link-local metadata, or the VPC.
 */
export async function resolveSafePublicHttpUrl(
  raw: string,
  opts: { maxRedirects?: number; timeoutMs?: number } = {},
): Promise<URL> {
  // 10, not 5: podcast/media enclosures routinely chain analytics redirects
  // (Podtrac→Chartable→CDN), which exceeded a 5-hop cap and failed legit files.
  const maxRedirects = opts.maxRedirects ?? 10;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let current = await assertSafePublicHttpUrl(raw);
  for (let i = 0; i < maxRedirects; i += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      // `safeFetch` validates the (possibly redirected) URL, resolves + pins
      // one DNS answer into the actual TCP/TLS connect so an attacker
      // can't rebind the host A record between validation and fetch.
      response = await safeFetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'DeepmarksArchiveWorker/1.0' },
      });
    } catch {
      return current;
    } finally {
      clearTimeout(timer);
    }
    if (response.status < 300 || response.status >= 400) return current;
    const location = response.headers.get('location');
    if (!location) throw new UnsafeUrlError('redirect missing location');
    current = await assertSafePublicHttpUrl(new URL(location, current).toString());
  }
  throw new UnsafeUrlError('too many redirects');
}
