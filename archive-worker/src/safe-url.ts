// SSRF guard for the archive worker. Run before any wayback fetch or
// playwright render. Same predicate core as api/src/safe-url.ts (shared
// via the generated safe-url-core module — edit
// packages/safe-url-core/safe-url-core.ts, never the copy), plus a DNS
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
import {
  UnsafeUrlError,
  embeddedIpv4,
  isPrivateIp,
  looksLikeIp,
} from './safe-url-core.js';

export { UnsafeUrlError, embeddedIpv4, isPrivateIp, looksLikeIp };

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
 *  validated addresses. NOTE the TOCTOU residual documented in the file
 *  header: nothing currently pins `addresses` into the subsequent
 *  fetch's connect, so an attacker flipping the host's A record between
 *  this resolve and the fetch (a window of milliseconds) can defeat the
 *  private-range check. `addresses` is returned so a future
 *  connect-pinning fetch can consume it. */
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
  // DNS resolve and reject if ANY result is private.
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
      // safeFetch validates + resolves the (possibly redirected) URL and
      // rejects private answers. It does NOT connect-pin the resolved IP
      // (see the file-header residual) — each hop is validated, not
      // rebinding-proof.
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
