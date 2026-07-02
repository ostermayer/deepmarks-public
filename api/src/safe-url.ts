// SSRF guard for any URL the user submits to be fetched / rendered by an
// internal worker (archive worker on Box B). Two layers:
//
//   1. `validateSafePublicHttpUrl()` — sync, scheme + literal-IP checks.
//      Used in the request-validation path so we reject obvious internal
//      targets (file://, http://10.x, http://169.254.169.254) before
//      ever queueing a job.
//   2. `assertSafeResolvedPublicHttpUrl()` — async, DNS-resolve + re-check
//      that every resolved address is public. Use it before api
//      fetches user-controlled URLs so a hostname like
//      `internal.evil.com -> 10.0.0.4` doesn't sneak past layer 1.
//
// The archive worker has a mirrored guard because it performs the final
// render/fetch on Box B.

import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

export class UnsafeUrlError extends Error {
  constructor(public reason: string) {
    super(`unsafe url: ${reason}`);
    this.name = 'UnsafeUrlError';
  }
}

/** Sync validation. Throws UnsafeUrlError on rejection. */
export function validateSafePublicHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UnsafeUrlError('not a valid url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError(`scheme ${parsed.protocol} not allowed`);
  }
  const host = parsed.hostname;
  if (!host) throw new UnsafeUrlError('empty host');
  // Single-label hosts (`localhost`, `redis`, `api`) resolve
  // inside the docker network. The renderer is on Box B, so its DNS
  // could surface those container hostnames if puppeteer ever ran in a
  // container that joined the same network. Belt-and-suspenders.
  if (!host.includes('.') && !looksLikeIp(host)) {
    throw new UnsafeUrlError('single-label host disallowed');
  }
  // IP literals — reject the obvious private ranges + loopback +
  // link-local + IPv6 ULA + IPv6 loopback.
  if (looksLikeIp(host) && isPrivateIp(host)) {
    throw new UnsafeUrlError(`ip ${host} is private/loopback/link-local`);
  }
  // Common typo / sneaky hostnames.
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')) {
    throw new UnsafeUrlError(`hostname ${lower} is local`);
  }
  return parsed;
}

export function looksLikeIp(host: string): boolean {
  return isIP(normalizeIpLiteralHost(host)) !== 0;
}

export type PublicDnsLookup = (host: string) => Promise<Array<{ address: string }>>;

export async function assertSafeResolvedPublicHttpUrl(
  raw: string,
  opts: { dnsLookup?: PublicDnsLookup } = {},
): Promise<URL> {
  const parsed = validateSafePublicHttpUrl(raw);
  const host = parsed.hostname;
  if (looksLikeIp(host)) return parsed;

  const lookup = opts.dnsLookup ?? defaultDnsLookup;
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host);
  } catch (err) {
    throw new UnsafeUrlError(`dns lookup failed: ${(err as Error).message}`);
  }
  if (addrs.length === 0) throw new UnsafeUrlError('no dns answers');
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new UnsafeUrlError(`${host} resolves to private ${address}`);
  }
  return parsed;
}

async function defaultDnsLookup(host: string): Promise<Array<{ address: string }>> {
  return dns.lookup(host, { all: true, verbatim: true });
}

type FetchInitLike = Omit<RequestInit, 'dispatcher'>;

/**
 * Validate a URL, DNS-resolve it, reject if any resolved address is private,
 * then fetch. This is the SSRF-guarded fetch every user-URL fetcher on Box A
 * should use so the private-range check isn't accidentally skipped.
 *
 * Residual: this is NOT IP-pinned — the guard resolves the host and the
 * subsequent `fetch` re-resolves it independently, so a DNS-rebinding
 * attacker who flips the A record between the two lookups (a small timing
 * window) could still reach a private target. Callers additionally follow
 * redirects with `redirect: 'manual'` + a per-hop re-check, which closes the
 * redirect-based SSRF; the rebinding residual is a tracked follow-up (a
 * connect-level IP pin needs undici's own fetch to match its Agent version,
 * which differs between the boxes). Mirrors `archive-worker/src/safe-url.ts`.
 */
export async function safeFetch(
  input: string | URL,
  init: FetchInitLike = {},
  opts: { dnsLookup?: PublicDnsLookup } = {},
): Promise<Response> {
  const parsed = await assertSafeResolvedPublicHttpUrl(
    typeof input === 'string' ? input : input.toString(),
    opts,
  );
  return fetch(parsed, init);
}

/** Returns true for any IP we don't want internal services to fetch. */
export function isPrivateIp(ip: string): boolean {
  ip = normalizeIpLiteralHost(ip);
  // IPv4
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number) as [number, number, number, number];
    if (a === 10) return true;
    if (a === 127) return true;                              // loopback
    if (a === 0) return true;                                // unspecified
    if (a === 169 && b === 254) return true;                 // link-local incl. metadata
    if (a === 172 && b >= 16 && b <= 31) return true;        // RFC1918
    if (a === 192 && b === 168) return true;                 // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT
    if (a >= 224) return true;                               // multicast / reserved
    return false;
  }
  // IPv6 — strip zone, lower-case
  const v6 = ip.split('%')[0].toLowerCase();
  if (v6 === '::1' || v6 === '::' || v6 === '0:0:0:0:0:0:0:1') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true;       // ULA
  if (v6.startsWith('fe80:') || v6.startsWith('fe8') || v6.startsWith('fe9') ||
      v6.startsWith('fea') || v6.startsWith('feb')) return true;     // link-local
  // IPv4-mapped / -compatible IPv6 (e.g. ::ffff:10.0.0.4, which the WHATWG
  // URL parser normalizes to the hex form ::ffff:a00:4). These route to the
  // embedded IPv4 on a dual-stack host, so re-run the v4 checks on it.
  const mapped = embeddedIpv4(v6);
  if (mapped) return isPrivateIp(mapped);
  return false;
}

/** Extract the embedded IPv4 from an IPv4-mapped/-compatible IPv6 literal,
 *  in either dotted (`::ffff:10.0.0.1`) or the URL-parser-normalized hex
 *  form (`::ffff:a00:1`), compressed or fully expanded. Returns a
 *  dotted-quad string or null. Without this, `http://[::ffff:10.0.0.4]/`
 *  bypassed the guard entirely — the hex form never matched the old
 *  dotted-only `::ffff:` check, so a mapped literal resolved to an internal
 *  IPv4 target (Box C 10.0.0.4, 169.254.169.254, …) and read as public. */
export function embeddedIpv4(v6: string): string | null {
  const dotted = /^(?:::ffff:|(?:0:){5}ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/.exec(v6);
  if (dotted && dotted[1]) return dotted[1];
  const hex = /^(?:::ffff:|(?:0:){5}ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (hex && hex[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function normalizeIpLiteralHost(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}
