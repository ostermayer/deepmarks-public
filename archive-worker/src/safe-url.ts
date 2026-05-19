// SSRF guard for the archive worker. Run before any wayback fetch or
// playwright render. Mirror of payment-proxy/src/safe-url.ts plus a DNS
// resolve so a hostname like `internal.evil.com → 10.0.0.4` can't sneak
// past the proxy's sync check.

import { promises as dns } from 'node:dns';

export class UnsafeUrlError extends Error {
  constructor(reason: string) {
    super(`unsafe url: ${reason}`);
    this.name = 'UnsafeUrlError';
  }
}

export function looksLikeIp(host: string): boolean {
  return /^[0-9.]+$/.test(host) || /^[0-9a-fA-F:]+$/.test(host);
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
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new UnsafeUrlError('not a valid url'); }
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
    return parsed;
  }
  // DNS resolve and reject if ANY result is private. Avoid TOCTOU drift
  // between this check and the actual fetch by using a short-TTL cache
  // upstream if needed.
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new UnsafeUrlError(`dns lookup failed: ${(err as Error).message}`);
  }
  if (addrs.length === 0) throw new UnsafeUrlError('no dns answers');
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new UnsafeUrlError(`${host} resolves to private ${address}`);
  }
  return parsed;
}
