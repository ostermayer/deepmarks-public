// Site-favicon cache.
//
// The landing feed renders one favicon per bookmark row — so the endpoint
// that backs them has to be cheap and tolerant of weird websites. Design:
//
//   1. GET /favicon?host=<host> — Fastify route that calls `resolveUrl`.
//   2. `resolveUrl` checks Redis for a prior hit/miss marker.
//   3. On cache miss, we try four sources in order until one returns bytes
//      that MIME-sniff as an image: the site's own /favicon.ico, the
//      homepage's <link rel="icon"> tag, Google's favicon service, and
//      DuckDuckGo's favicon service.
//   4. First success is uploaded to a **public-read** Linode Object Storage
//      bucket; Redis remembers the extension so the same object key is
//      served for subsequent requests.
//   5. All four failing → Redis gets a "miss" marker (7-day TTL, so we
//      retry eventually) and the client is 302'd to `default.svg` in the
//      same bucket.
//
// The route always responds with a 302 redirect — we never proxy image
// bytes through payment-proxy for cache hits. That keeps the API process
// off the hot path; browsers and Cloudflare cache the Linode URL directly.

import { Redis } from 'ioredis';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
} from '@aws-sdk/client-s3';
import * as cheerio from 'cheerio';

const REDIS_PREFIX = 'dm:favicon:';
const HIT_TTL_SECONDS = 60 * 60 * 24 * 30;     // 30 days; favicons change rarely
const MISS_TTL_SECONDS = 60 * 60 * 24 * 7;     // 7 days; retry failing sites weekly
const MAX_FAVICON_BYTES = 200 * 1024;          // 200 KB — well above any real favicon
const FETCH_TIMEOUT_MS = 5_000;
const HOMEPAGE_MAX_HTML_BYTES = 200 * 1024;    // parse only the first 200 KB of HTML
const DEFAULT_OBJECT_KEY = 'default.svg';

export interface FaviconConfig {
  /** S3 endpoint URL, e.g. https://us-southeast-1.linodeobjects.com */
  endpoint: string;
  /** S3 region — Linode wants the subdomain label as its region (us-southeast-1). */
  region: string;
  /** Bucket name, public-read ACL. */
  bucket: string;
  accessKey: string;
  secretKey: string;
  /**
   * Public URL prefix to redirect browsers to. Defaults to virtual-host
   * style: https://<bucket>.<endpoint-host>. Override via FAVICON_PUBLIC_BASE
   * when the bucket is fronted by a CDN or on path-style hosting.
   */
  publicBase: string;
}

export interface FaviconLogger {
  info: (msg: object | string, ...rest: unknown[]) => void;
  warn: (msg: object | string, ...rest: unknown[]) => void;
  error: (msg: object | string, ...rest: unknown[]) => void;
}

/** Load config from env. Returns null (disabled) if any required var is missing. */
export function faviconConfigFromEnv(): FaviconConfig | null {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.FAVICON_BUCKET;
  const accessKey = process.env.LINODE_ACCESS_KEY;
  const secretKey = process.env.LINODE_SECRET_KEY;
  const region = process.env.S3_REGION ?? 'us-southeast-1';
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;

  let publicBase = process.env.FAVICON_PUBLIC_BASE ?? '';
  if (!publicBase) {
    // Virtual-host style: https://<bucket>.<endpoint-host>
    try {
      const u = new URL(endpoint);
      publicBase = `${u.protocol}//${bucket}.${u.host}`;
    } catch {
      return null;
    }
  }
  publicBase = publicBase.replace(/\/+$/, '');

  return { endpoint, region, bucket, accessKey, secretKey, publicBase };
}

/**
 * Normalize + validate a host string. Returns null for anything we refuse
 * to look up — IPs, single-label hosts, overlong strings, illegal chars.
 * Callers should treat null as "bad request, do not fetch".
 */
export function normalizeHost(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let h = input.trim().toLowerCase();
  if (!h) return null;

  // Strip a leading scheme if someone passed a full URL.
  h = h.replace(/^https?:\/\//, '');
  // Strip path / query / fragment.
  h = h.split('/')[0].split('?')[0].split('#')[0];
  // Strip user:pass@
  const atIdx = h.lastIndexOf('@');
  if (atIdx >= 0) h = h.slice(atIdx + 1);
  // Strip :port
  const colonIdx = h.indexOf(':');
  if (colonIdx >= 0) h = h.slice(0, colonIdx);
  // Trailing dot (fully-qualified form) is legal DNS but noise here.
  h = h.replace(/\.$/, '');

  if (h.length === 0 || h.length > 253) return null;

  // Allowed chars: a-z, 0-9, dot, dash. Internationalized domains should
  // be Punycode-encoded before hitting this endpoint.
  if (!/^[a-z0-9.-]+$/.test(h)) return null;
  // Must have at least one dot — no "localhost", no single-label intranet
  // hosts, no bare TLDs.
  if (!h.includes('.')) return null;
  // Reject if any label is empty (leading/trailing/double dot) or >63 chars.
  for (const label of h.split('.')) {
    if (label.length === 0 || label.length > 63) return null;
    if (label.startsWith('-') || label.endsWith('-')) return null;
  }
  // Reject IPv4 literals — favicons don't live on raw IPs and we don't
  // want our server fetching arbitrary internal addresses by mistake.
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) return null;

  return h;
}

/** Sniff the leading bytes of a response body and return a file extension,
 *  or null if the bytes don't look like a supported image format. */
export function sniffImageExtension(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  // ICO: 00 00 01 00
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'ico';
  // PNG: 89 50 4e 47 0d 0a 1a 0a
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'png';
  // JPEG: ff d8 ff
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  // GIF87a / GIF89a
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'gif';
  // WEBP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'webp';
  // SVG: text — we look for "<svg" within the first 256 bytes, after
  // optional BOM / whitespace / XML prolog. Permissive on purpose.
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 256)).toLowerCase();
  if (head.includes('<svg')) return 'svg';
  return null;
}

function contentTypeFor(ext: string): string {
  switch (ext) {
    case 'ico': return 'image/x-icon';
    case 'png': return 'image/png';
    case 'jpg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

/** Fetch with AbortSignal timeout. Returns null on any error or non-2xx.
 *  Bounded to a small redirect chain so an attacker controlling a
 *  hostname can't stitch a long redirect path into internal-network
 *  probing (e.g. /favicon.ico → 302 → http://10.0.0.1:8500/v1/...).
 *  Each hop's destination is re-validated through validateFetchUrl. */
async function fetchBytes(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Uint8Array | null> {
  const MAX_REDIRECTS = 3;
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isPublicLooking(current)) return null;
      const res = await fetch(current, {
        signal: AbortSignal.timeout(timeoutMs),
        // Manual redirect handling so we can re-check each hop's host.
        redirect: 'manual',
        headers: {
          'user-agent': 'deepmarks-favicon-cache/1.0 (+https://deepmarks.org)',
          'accept': 'image/*, */*;q=0.5',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return null;
        try { current = new URL(loc, current).toString(); }
        catch { return null; }
        continue;
      }
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0 || buf.byteLength > MAX_FAVICON_BYTES) return null;
      return new Uint8Array(buf);
    }
    return null;
  } catch {
    return null;
  }
}

/** Cheap check on a fetch destination: must be http(s), and the host
 *  must not be a private-IP literal. DNS-rebind attacks (where a
 *  hostname resolves to an internal IP) still slip past this — fixing
 *  that requires a custom Node dispatcher with a connect-hook. This
 *  filter at least kills the literal-IP form an attacker can put in a
 *  redirect Location header. */
function isPublicLooking(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  // IPv4 literal — reject private ranges. (IPv6 ULA is similar but
  // exotic enough we don't bother; the caller's normalizeHost won't
  // accept IPv6 anyway.)
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    const parts = host.split('.').map((p) => Number(p));
    const [a, b] = parts as [number, number];
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 0) return false;
    if (a >= 224) return false; // multicast / reserved
  }
  return true;
}

/** Parse the homepage for <link rel="icon"> / "shortcut icon" / "apple-touch-icon".
 *  Returns the resolved icon URL or null. The fetch follows up to 3
 *  redirects with a per-hop public-IP check (same posture as fetchBytes). */
export async function findIconFromHomepage(host: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  const MAX_REDIRECTS = 3;
  try {
    let current = `https://${host}/`;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isPublicLooking(current)) return null;
      const r = await fetch(current, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
        headers: {
          'user-agent': 'deepmarks-favicon-cache/1.0 (+https://deepmarks.org)',
          'accept': 'text/html',
        },
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) return null;
        try { current = new URL(loc, current).toString(); }
        catch { return null; }
        continue;
      }
      res = r;
      break;
    }
    if (!res || !res.ok) return null;
    // Bound the HTML we parse — huge pages would waste CPU and we only
    // need the <head>.
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (received < HOMEPAGE_MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    const html = new TextDecoder('utf-8', { fatal: false }).decode(concatChunks(chunks));
    const $ = cheerio.load(html);
    // Prefer larger icons when multiple are declared.
    const candidates: Array<{ href: string; size: number }> = [];
    $('link[rel]').each((_i, el) => {
      const rel = ($(el).attr('rel') ?? '').toLowerCase();
      if (!rel.includes('icon')) return;
      const href = $(el).attr('href');
      if (!href) return;
      const sizes = $(el).attr('sizes') ?? '';
      const dim = Number.parseInt(sizes.split(/x|\s+/)[0] ?? '0', 10);
      candidates.push({ href, size: Number.isFinite(dim) ? dim : 0 });
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.size - a.size);
    try {
      return new URL(candidates[0].href, `https://${host}/`).toString();
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** One step in the fallback chain: returns either sniffed bytes or null. */
export type FaviconSource = {
  name: string;
  fetch: (host: string) => Promise<{ bytes: Uint8Array; ext: string } | null>;
};

/** The source chain in the order we try them. Exported so tests can swap
 *  it out for a mocked sequence without touching the production network. */
export function defaultSources(): FaviconSource[] {
  return [
    {
      name: 'direct',
      fetch: async (host) => {
        const bytes = await fetchBytes(`https://${host}/favicon.ico`);
        if (!bytes) return null;
        const ext = sniffImageExtension(bytes);
        return ext ? { bytes, ext } : null;
      },
    },
    {
      name: 'homepage',
      fetch: async (host) => {
        const iconUrl = await findIconFromHomepage(host);
        if (!iconUrl) return null;
        const bytes = await fetchBytes(iconUrl);
        if (!bytes) return null;
        const ext = sniffImageExtension(bytes);
        return ext ? { bytes, ext } : null;
      },
    },
    {
      name: 'google',
      fetch: async (host) => {
        const bytes = await fetchBytes(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`);
        if (!bytes) return null;
        const ext = sniffImageExtension(bytes);
        return ext ? { bytes, ext } : null;
      },
    },
    {
      name: 'duckduckgo',
      fetch: async (host) => {
        const bytes = await fetchBytes(`https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`);
        if (!bytes) return null;
        const ext = sniffImageExtension(bytes);
        return ext ? { bytes, ext } : null;
      },
    },
  ];
}

interface HitMarker { kind: 'hit'; ext: string; source: string; at: number }
interface MissMarker { kind: 'miss'; at: number }
type Marker = HitMarker | MissMarker;

/** A simple SVG used when all four sources fail for a host. Kept as a
 *  string so we can upload it on boot without shipping a separate file.
 *  Neutral globe-ish shape, coral stroke to match the Deepmarks palette. */
export const DEFAULT_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">
  <rect width="32" height="32" fill="#f4f1ec"/>
  <g fill="none" stroke="#6b8198" stroke-width="1.5">
    <circle cx="16" cy="16" r="9"/>
    <ellipse cx="16" cy="16" rx="4" ry="9"/>
    <line x1="7" y1="16" x2="25" y2="16"/>
  </g>
</svg>
`;

export class FaviconStore {
  constructor(
    private readonly redis: Redis,
    private readonly s3: S3Client,
    private readonly config: FaviconConfig,
    private readonly logger: FaviconLogger,
    private readonly sources: FaviconSource[] = defaultSources(),
  ) {}

  /**
   * Resolve a host to a public URL the caller can 302 to. Never throws
   * on upstream failures — falls back to the default icon.
   */
  async resolveUrl(host: string): Promise<string> {
    const marker = await this.readMarker(host);
    if (marker?.kind === 'hit') return this.publicUrlFor(host, marker.ext);
    if (marker?.kind === 'miss') return this.defaultUrl();

    for (const src of this.sources) {
      const result = await src.fetch(host);
      if (!result) continue;
      try {
        await this.upload(this.objectKeyFor(host, result.ext), result.bytes, result.ext);
        await this.writeHit(host, result.ext, src.name);
        this.logger.info({ host, source: src.name, ext: result.ext, bytes: result.bytes.byteLength }, 'favicon cached');
        return this.publicUrlFor(host, result.ext);
      } catch (err) {
        // S3 failure shouldn't kill the request — return the bytes' source
        // URL wouldn't help either (we don't have it post-sniff), so we fall
        // through to the next source. If every source then fails *and* S3
        // is down, the default path below still serves the preuploaded SVG
        // (which doesn't need a fresh S3 call).
        this.logger.warn({ host, source: src.name, err }, 'favicon upload failed');
      }
    }

    await this.writeMiss(host);
    return this.defaultUrl();
  }

  /** Upload the default SVG to the bucket on boot, if it isn't there. */
  async ensureDefaultExists(): Promise<void> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: DEFAULT_OBJECT_KEY }));
      return; // already uploaded
    } catch (err) {
      if (!(err instanceof NoSuchKey) && !(err instanceof NotFound)) {
        // HeadObject can throw a plain 404 that doesn't match either class
        // depending on Linode's response shape. Treat any miss as "upload".
        if (!is404(err)) {
          this.logger.warn({ err }, 'favicon default HEAD failed');
          return;
        }
      }
    }
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: DEFAULT_OBJECT_KEY,
          Body: DEFAULT_SVG,
          ContentType: 'image/svg+xml',
          ACL: 'public-read',
          CacheControl: 'public, max-age=86400',
        }),
      );
      this.logger.info({ bucket: this.config.bucket, key: DEFAULT_OBJECT_KEY }, 'favicon default uploaded');
    } catch (err) {
      this.logger.warn({ err }, 'favicon default upload failed');
    }
  }

  defaultUrl(): string {
    return `${this.config.publicBase}/${DEFAULT_OBJECT_KEY}`;
  }

  private publicUrlFor(host: string, ext: string): string {
    return `${this.config.publicBase}/${this.objectKeyFor(host, ext)}`;
  }

  private objectKeyFor(host: string, ext: string): string {
    return `icons/${host}.${ext}`;
  }

  private async upload(key: string, bytes: Uint8Array, ext: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentTypeFor(ext),
        ACL: 'public-read',
        CacheControl: 'public, max-age=604800',
      }),
    );
  }

  private async readMarker(host: string): Promise<Marker | null> {
    const raw = await this.redis.get(REDIS_PREFIX + host);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Marker;
    } catch {
      return null;
    }
  }

  private async writeHit(host: string, ext: string, source: string): Promise<void> {
    const m: HitMarker = { kind: 'hit', ext, source, at: Math.floor(Date.now() / 1000) };
    await this.redis.set(REDIS_PREFIX + host, JSON.stringify(m), 'EX', HIT_TTL_SECONDS);
  }

  private async writeMiss(host: string): Promise<void> {
    const m: MissMarker = { kind: 'miss', at: Math.floor(Date.now() / 1000) };
    await this.redis.set(REDIS_PREFIX + host, JSON.stringify(m), 'EX', MISS_TTL_SECONDS);
  }
}

function is404(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as { $metadata?: { httpStatusCode?: number }; name?: string };
  return anyErr.$metadata?.httpStatusCode === 404 || anyErr.name === 'NotFound' || anyErr.name === 'NoSuchKey';
}

/** Build an S3Client configured for Linode Object Storage. */
export function buildFaviconS3Client(config: FaviconConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    // Linode supports virtual-host style with wildcard SSL; keep the SDK's
    // default (forcePathStyle: false) so the public URLs match.
  });
}
