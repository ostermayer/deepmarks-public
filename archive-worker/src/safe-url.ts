// SSRF guard for the archive worker. Run before any wayback fetch or
// playwright render. Mirror of api/src/safe-url.ts plus a DNS
// resolve so a hostname like `internal.evil.com → 10.0.0.4` can't sneak
// past the sync scheme/literal check.
//
// `safeFetch` validates the URL, DNS-resolves it, rejects any private
// resolved address, then fetches. It is NOT connect-level IP-pinned:
// the resolve and the fetch's own resolution are separate, so a
// DNS-rebinding attacker who flips the A record between them (a small
// timing window) is a known residual. Callers close the redirect-based
// SSRF by following redirects with `redirect: 'manual'` and re-validating
// each hop. A connect-level pin needs undici's own fetch paired with its
// Agent (the boxes' undici versions diverge), tracked as a follow-up.

import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

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
  // Strip surrounding brackets first — the IP-literal branch in
  // resolveSafePublicUrl passes `url.hostname`, which for IPv6 keeps the
  // `[...]`. Without this, `[::1]` / `[fd00::1]` / `[::ffff:a00:4]` never
  // matched any check below and read as public (SSRF bypass).
  ip = normalizeIpLiteralHost(ip);
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
  // IPv4-mapped / -compatible IPv6 (e.g. ::ffff:10.0.0.4 → hex ::ffff:a00:4).
  // Routes to the embedded IPv4 on a dual-stack host, so re-run the v4 checks.
  const mapped = embeddedIpv4(v6);
  if (mapped) return isPrivateIp(mapped);
  return false;
}

/** Extract the embedded IPv4 from an IPv4-mapped/-compatible IPv6 literal,
 *  in either dotted (`::ffff:10.0.0.1`) or the URL-parser-normalized hex
 *  form (`::ffff:a00:1`), compressed or fully expanded. Mirrors
 *  `api/src/safe-url.ts:embeddedIpv4`. */
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
 * Validate + DNS-resolve + reject-if-private, then fetch. The SSRF-guarded
 * fetch every user-URL byte download on Box B should use.
 *
 * Residual: NOT IP-pinned — resolveSafePublicUrl resolves the host and the
 * subsequent `fetch` re-resolves it, so a DNS-rebinding attacker who flips
 * the A record between the two lookups (small timing window) could still
 * reach a private target. Callers follow redirects with `redirect: 'manual'`
 * + a per-hop re-check (closes redirect-based SSRF); the rebinding residual
 * is a tracked follow-up (connect-level pinning needs undici's own fetch to
 * match its Agent version, which differs across the deployed boxes).
 */
export async function safeFetch(
  input: string | URL,
  init: FetchInitLike = {},
): Promise<Response> {
  const { url } = await resolveSafePublicUrl(input);
  return fetch(url, init);
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
