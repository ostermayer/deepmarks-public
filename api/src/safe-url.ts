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
// The predicate core (UnsafeUrlError, looksLikeIp, isPrivateIp,
// embeddedIpv4) is shared with the archive worker via the generated
// safe-url-core module — edit packages/safe-url-core/safe-url-core.ts,
// never the copy. The archive worker keeps its own higher-level guard
// because it performs the final render/fetch on Box B.

import { promises as dns } from 'node:dns';
import {
  UnsafeUrlError,
  embeddedIpv4,
  isPrivateIp,
  looksLikeIp,
} from './safe-url-core.js';

export { UnsafeUrlError, embeddedIpv4, isPrivateIp, looksLikeIp };

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

/**
 * Manually follow up to `maxRedirects`, re-validating every hop with the
 * caller's gate BEFORE fetching it — without per-hop validation, an
 * attacker-controlled hostname can 30x a validated URL into
 * `http://10.0.0.x/...` and turn a preview fetch into an internal-network
 * probe. This loop was hand-copied at four call sites (preview, oEmbed,
 * favicon bytes, favicon homepage) with drifting validators; this is the one
 * copy. `doFetch` must use `redirect: 'manual'`. Returns the final non-3xx
 * Response, or null when validation fails, a Location is missing/garbled, or
 * the redirect budget is exhausted.
 */
export async function followRedirectsSafely(
  startUrl: string,
  doFetch: (url: string) => Promise<Response>,
  validate: (url: string) => boolean | Promise<boolean>,
  maxRedirects = 3,
): Promise<Response | null> {
  let current = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!(await validate(current))) return null;
    const res = await doFetch(current);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      void res.body?.cancel().catch(() => undefined);
      if (!location) return null;
      try {
        current = new URL(location, current).toString();
      } catch {
        return null;
      }
      continue;
    }
    return res;
  }
  return null;
}
