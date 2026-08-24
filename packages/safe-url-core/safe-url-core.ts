// ═══════════════════════════════════════════════════════════════════════
// CANONICAL SOURCE — packages/safe-url-core/safe-url-core.ts
//
// The SSRF predicate core shared by api and archive-worker. Every past
// bypass fix here (isIP strictness, IPv6 bracket stripping, hex-form
// IPv4-mapped literals) had to be hand-ported between two copies and
// could silently drift (2026-08-23 review, simplification backlog).
//
// Edit THIS file, then run:  node scripts/sync-shared-modules.mjs
// which regenerates the checked-in copies at api/src/safe-url-core.ts
// and archive-worker/src/safe-url-core.ts (each package's Docker build
// context only contains its own directory, so a runtime workspace
// dependency can't reach the images — generated copies + parity tests
// give one source of truth without touching the build system). A parity
// test in each suite fails if a copy drifts from this file.
//
// The higher-level guards (validate/assert/safeFetch/redirect-following)
// deliberately stay per-package in each safe-url.ts — their API surfaces
// and fetch policies differ by design.
// ═══════════════════════════════════════════════════════════════════════

import { isIP } from 'node:net';

export class UnsafeUrlError extends Error {
  constructor(public reason: string) {
    super(`unsafe url: ${reason}`);
    this.name = 'UnsafeUrlError';
  }
}

/** Strip surrounding `[...]` from IPv6-literal hostnames so `isIP` and
 *  the range checks see the bare address. WHATWG `url.hostname` keeps
 *  the brackets for IPv6 — without this, `[::1]` / `[fd00::1]` /
 *  `[::ffff:a00:4]` never matched any check and read as public (SSRF
 *  bypass, fixed 2026-07). */
export function normalizeIpLiteralHost(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

/** True iff `host` parses as an IPv4 or IPv6 literal. Uses `node:net.isIP`
 *  (strict — rejects hex-looking single labels like `deadbeef`, which the
 *  old `/^[0-9.]+$/ || /^[0-9a-fA-F:]+$/` regex wrongly classified as an
 *  IP and then mishandled downstream). */
export function looksLikeIp(host: string): boolean {
  return isIP(normalizeIpLiteralHost(host)) !== 0;
}

/** Returns true for any IP internal services must never fetch: RFC1918,
 *  loopback, unspecified, link-local (incl. 169.254.169.254 metadata),
 *  CGNAT, multicast/reserved, IPv6 ULA + link-local + loopback, and
 *  IPv4-mapped/-compatible IPv6 (re-checked as the embedded IPv4). */
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
  const v6 = (ip.split('%')[0] ?? '').toLowerCase();
  if (v6 === '::1' || v6 === '::' || v6 === '0:0:0:0:0:0:0:1') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true;       // ULA
  if (v6.startsWith('fe8') || v6.startsWith('fe9') ||
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
