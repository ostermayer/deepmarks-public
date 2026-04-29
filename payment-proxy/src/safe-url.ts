// SSRF guard for any URL the user submits to be fetched / rendered by an
// internal worker (archive worker on Box B). Two layers:
//
//   1. `validateSafePublicHttpUrl()` — sync, scheme + literal-IP checks.
//      Used in the request-validation path so we reject obvious internal
//      targets (file://, http://10.x, http://169.254.169.254) before
//      ever queueing a job.
//   2. `resolveAndCheckPublic()` — async, DNS-resolve + re-check that
//      every resolved address is public. Run on the worker right before
//      navigation so a hostname like `internal.evil.com → 10.0.0.4`
//      doesn't sneak past layer 1.
//
// Layer 2 lives in the worker, not here, but they share the predicate
// (`isPrivateIp`).

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
  // Single-label hosts (`localhost`, `redis`, `payment-proxy`) resolve
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

function looksLikeIp(host: string): boolean {
  // IPv6 in URLs is bracketed; URL.hostname strips the brackets.
  return /^[0-9.]+$/.test(host) || /^[0-9a-fA-F:]+$/.test(host);
}

/** Returns true for any IP we don't want internal services to fetch. */
export function isPrivateIp(ip: string): boolean {
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
  if (v6.startsWith('::ffff:')) {
    // IPv4-mapped — recurse on the trailing v4 if present.
    const tail = v6.slice('::ffff:'.length);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return isPrivateIp(tail);
  }
  return false;
}
