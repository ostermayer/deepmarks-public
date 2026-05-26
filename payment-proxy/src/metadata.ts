// URL metadata fetcher — powers autopopulate-title + tag-suggestions in
// the bookmark save UI. Given a URL, pull down ~256 KB of HTML and return:
//
//   { url, title?, description?, image?, favicon?, lightning?, mediaKind?, contentType?, suggestedTags[] }
//
// Every field is best-effort; a misbehaving page just means fewer fields,
// never an error bubbling up. Results are cached in Redis for 24 hours so
// pasting the same URL twice doesn't fetch twice.
//
// SSRF posture: we reject non-http(s) schemes, bare IPv4/IPv6 literals,
// and single-label hosts before fetching. We do NOT do DNS-resolution-
// and-compare (rebind-defence) — this is a preview endpoint, so the
// attack surface is tiny and the operational cost is high.
//
// The lightning-address field comes from the page's `<meta name="lightning">`
// tag or a `lightning:` link if any; that feeds the 10% site-operator leg
// of the zap split.
//
// suggestedTags are normalized single-word-with-[.-]-allowed tokens
// pulled from `<meta name="keywords">`, og:article:tag, and
// `<meta name="news_keywords">`.

import { Redis } from 'ioredis';
import * as cheerio from 'cheerio';
import { canonicalYoutubeUrl, parseYoutubeVideoId } from './youtube.js';

const REDIS_PREFIX = 'dm:metadata:';
/** Positive-cache TTL — metadata rarely changes on timescales that matter. */
const TTL_SECONDS = 60 * 60 * 24;
/** Negative-cache TTL — broken hosts (SSL errors, 5xx, non-HTML) shouldn't
 *  be refetched on every paste; short enough that a fixed site reappears
 *  without operator intervention. */
const NEGATIVE_TTL_SECONDS = 10 * 60;
const FETCH_TIMEOUT_MS = 6_000;
const YOUTUBE_OEMBED_TIMEOUT_MS = 3_000;
const MAX_HTML_BYTES = 256 * 1024; // 256 KB is plenty for <head> + some body
const MAX_SUGGESTED_TAGS = 8;
const MAX_TITLE_LEN = 300;
const MAX_DESCRIPTION_LEN = 500;

/** Default rate-limit window: 20 metadata resolves per IP per minute.
 *  Generous for a legitimate user pasting links; prevents an abuse
 *  script from turning payment-proxy into an open crawler. */
export const METADATA_RATE_LIMIT = { limit: 20, windowSeconds: 60 };

export type UrlMediaKind = 'image' | 'video' | 'audio';

export interface UrlMetadata {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
  lightning?: string;
  /** Direct media detected by HTTP content type when the URL has no useful file extension. */
  mediaKind?: UrlMediaKind;
  contentType?: string;
  suggestedTags: string[];
}

/**
 * Parse + validate a user-provided URL. Returns null for anything we
 * refuse to fetch — non-http(s), IP literals, single-label hosts, junk.
 */
export function parseAllowedUrl(input: unknown): URL | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = u.hostname.toLowerCase();
  if (!host) return null;
  // Reject bracketed IPv6 literals (fastest way to catch them is the
  // square brackets URL keeps around the host).
  if (host.includes(':')) return null;
  // Reject IPv4 literals — preview fetches shouldn't hit raw IPs.
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return null;
  // Require at least one dot — no localhost, no single-label intranet hosts.
  if (!host.includes('.')) return null;

  return u;
}

/** Clip text, trim, collapse whitespace, drop control characters. */
function cleanText(s: string | undefined | null, maxLen: number): string | undefined {
  if (!s) return undefined;
  const cleaned = s
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
}

/**
 * Normalize a free-text tag to at most one lowercase token.
 * Allowed chars: a-z 0-9 . -   (other chars → dropped as separators)
 * Returns null if nothing usable remains.
 */
export function normalizeTag(raw: string): string | null {
  const lowered = raw.toLowerCase().trim();
  if (!lowered) return null;
  // Keep only allowed chars, replacing everything else with spaces so
  // multi-word phrases get split by the caller (split on whitespace).
  const cleaned = lowered.replace(/[^a-z0-9.\-]+/g, ' ').trim();
  if (!cleaned) return null;
  // If the normalization produced multiple tokens, take the first.
  const first = cleaned.split(/\s+/)[0];
  // Trim leading/trailing punctuation that looks funky on its own.
  const stripped = first.replace(/^[.\-]+|[.\-]+$/g, '');
  if (!stripped || stripped.length > 40) return null;
  return stripped;
}

/** Split a free-text string into normalized tag tokens. */
export function tagsFromString(raw: string): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const piece of raw.split(/[,;|]+|\s{2,}/)) {
    // Each comma-delimited chunk may itself be a multi-word phrase —
    // normalizeTag takes only the first token, so split on whitespace
    // beforehand.
    for (const word of piece.split(/\s+/)) {
      const t = normalizeTag(word);
      if (t) out.push(t);
    }
  }
  return out;
}

function extractSuggestedTags($: cheerio.CheerioAPI): string[] {
  const raw: string[] = [];

  const metaKeywords = $('meta[name="keywords"]').attr('content');
  if (metaKeywords) raw.push(metaKeywords);

  const newsKeywords = $('meta[name="news_keywords"]').attr('content');
  if (newsKeywords) raw.push(newsKeywords);

  $('meta[property="article:tag"], meta[name="article:tag"]').each((_i, el) => {
    const c = $(el).attr('content');
    if (c) raw.push(c);
  });

  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of raw) {
    for (const tag of tagsFromString(chunk)) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
      if (out.length >= MAX_SUGGESTED_TAGS) return out;
    }
  }
  return out;
}

/**
 * Pull a lightning identifier from page metadata, restricted to formats
 * we can safely hand to the zap-split flow. Attacker-controlled pages
 * can otherwise inject arbitrary strings that the client would route to
 * their own wallet (the 10% "site operator" leg of NIP-57).
 */
export function isPlausibleLud16OrLnurl(raw: string): boolean {
  if (!raw) return false;
  if (raw.length > 200) return false;
  // lud16: local@domain.tld; conservative charset matches what real
  // lightning-address providers accept.
  if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw)) return true;
  // bech32 LNURL — lnurl prefix + base32-ish payload.
  if (/^lnurl1[02-9ac-hj-np-z]{50,}$/i.test(raw)) return true;
  return false;
}

function extractLightning($: cheerio.CheerioAPI): string | undefined {
  const candidates: string[] = [];
  const meta = $('meta[name="lightning"]').attr('content');
  if (meta) candidates.push(meta.trim());
  const link = $('link[rel="lightning"]').attr('href');
  if (link) candidates.push(link.trim().replace(/^lightning:/i, ''));
  for (const c of candidates) {
    if (isPlausibleLud16OrLnurl(c)) return c;
  }
  return undefined;
}

/** Resolve a page-supplied URL against `base`, returning it only if it
 *  ends up as plain http(s). Pages can declare `<link rel="icon"
 *  href="javascript:alert(1)">` or `<meta property="og:image"
 *  content="data:text/html,...">` and we'd otherwise hand those back
 *  to the UI; even though React doesn't render them as srcs, they can
 *  end up persisted as bookmark metadata or copied out into other
 *  contexts. Filter at extraction time. */
function safeResolveAssetUrl(href: string, base: URL): string | undefined {
  let resolved: URL;
  try { resolved = new URL(href, base); }
  catch { return undefined; }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
  return resolved.toString();
}

function extractFavicon($: cheerio.CheerioAPI, base: URL): string | undefined {
  let best: { href: string; size: number } | null = null;
  $('link[rel]').each((_i, el) => {
    const rel = ($(el).attr('rel') ?? '').toLowerCase();
    if (!rel.includes('icon')) return;
    const href = $(el).attr('href');
    if (!href) return;
    const sizes = $(el).attr('sizes') ?? '';
    const dim = Number.parseInt(sizes.split(/x|\s+/)[0] ?? '0', 10);
    const size = Number.isFinite(dim) ? dim : 0;
    if (!best || size > best.size) best = { href, size };
  });
  if (!best) return undefined;
  const pick = best as { href: string; size: number };
  return safeResolveAssetUrl(pick.href, base);
}

function extractImage($: cheerio.CheerioAPI, base: URL): string | undefined {
  const candidates = [
    $('meta[property="og:image"]').attr('content'),
    $('meta[property="og:image:url"]').attr('content'),
    $('meta[name="twitter:image"]').attr('content'),
    $('meta[name="twitter:image:src"]').attr('content'),
  ];
  for (const href of candidates) {
    if (!href) continue;
    const safe = safeResolveAssetUrl(href, base);
    if (safe) return safe;
  }
  return undefined;
}

export function youtubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export function youtubeMetadataFromOembed(url: string, body: unknown): UrlMetadata | null {
  const videoId = parseYoutubeVideoId(url);
  if (!videoId || !body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const title = cleanText(typeof record.title === 'string' ? record.title : undefined, MAX_TITLE_LEN);
  const author = cleanText(typeof record.author_name === 'string' ? record.author_name : undefined, 120);
  const thumbnail = typeof record.thumbnail_url === 'string'
    ? safeResolveAssetUrl(record.thumbnail_url, new URL(canonicalYoutubeUrl(videoId)))
    : undefined;
  return {
    url,
    title: title ?? 'YouTube video',
    description: author ? `YouTube video by ${author}` : undefined,
    image: thumbnail ?? youtubeThumbnailUrl(videoId),
    suggestedTags: [],
  };
}

async function fetchYoutubeMetadata(url: string): Promise<UrlMetadata | null> {
  const videoId = parseYoutubeVideoId(url);
  if (!videoId) return null;
  const canonical = canonicalYoutubeUrl(videoId);
  const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonical)}`;
  try {
    const res = await fetch(endpoint, {
      signal: AbortSignal.timeout(YOUTUBE_OEMBED_TIMEOUT_MS),
      headers: {
        'accept': 'application/json',
        'user-agent': 'deepmarks-metadata/1.0 (+https://deepmarks.org)',
      },
    });
    if (res.ok) {
      const data = await res.json();
      const meta = youtubeMetadataFromOembed(url, data);
      if (meta) return meta;
    }
  } catch {
    // Fall back to a deterministic thumbnail; the regular HTML fetch
    // often gets a YouTube consent/login page and produces worse data.
  }
  return {
    url,
    title: 'YouTube video',
    image: youtubeThumbnailUrl(videoId),
    suggestedTags: [],
  };
}

function extractTitle($: cheerio.CheerioAPI): string | undefined {
  const og = $('meta[property="og:title"]').attr('content');
  if (og) {
    const t = cleanText(og, MAX_TITLE_LEN);
    if (t) return t;
  }
  const tw = $('meta[name="twitter:title"]').attr('content');
  if (tw) {
    const t = cleanText(tw, MAX_TITLE_LEN);
    if (t) return t;
  }
  const title = $('title').first().text();
  return cleanText(title, MAX_TITLE_LEN);
}

function extractDescription($: cheerio.CheerioAPI): string | undefined {
  const og = $('meta[property="og:description"]').attr('content');
  if (og) {
    const t = cleanText(og, MAX_DESCRIPTION_LEN);
    if (t) return t;
  }
  const tw = $('meta[name="twitter:description"]').attr('content');
  if (tw) {
    const t = cleanText(tw, MAX_DESCRIPTION_LEN);
    if (t) return t;
  }
  const meta = $('meta[name="description"]').attr('content');
  return cleanText(meta, MAX_DESCRIPTION_LEN);
}

function normalizedContentType(raw: string | null | undefined): string | undefined {
  const type = raw?.split(';')[0]?.trim().toLowerCase();
  return type || undefined;
}

export function mediaKindFromContentType(raw: string | null | undefined): UrlMediaKind | null {
  const contentType = normalizedContentType(raw);
  if (!contentType) return null;
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return null;
}

export function metadataFromMediaContentType(url: string, rawContentType: string | null | undefined): UrlMetadata | null {
  const contentType = normalizedContentType(rawContentType);
  const mediaKind = mediaKindFromContentType(contentType);
  if (!contentType || !mediaKind) return null;
  const meta: UrlMetadata = {
    url,
    title: mediaTitle(url, mediaKind),
    mediaKind,
    contentType,
    suggestedTags: [],
  };
  if (mediaKind === 'image') meta.image = url;
  return meta;
}

function mediaTitle(url: string, mediaKind: UrlMediaKind): string | undefined {
  try {
    const host = new URL(url).host.replace(/^www\./i, '');
    return `${mediaKind} from ${host}`;
  } catch {
    return undefined;
  }
}

/**
 * Parse already-fetched HTML into a UrlMetadata. Exposed so tests can
 * verify the extraction logic without touching the network.
 */
export function extractMetadata(url: string, html: string): UrlMetadata {
  const $ = cheerio.load(html);
  const base = new URL(url);
  return {
    url,
    title: extractTitle($),
    description: extractDescription($),
    image: extractImage($, base),
    favicon: extractFavicon($, base),
    lightning: extractLightning($),
    suggestedTags: extractSuggestedTags($),
  };
}

type FetchedPreviewResource =
  | { kind: 'html'; html: string }
  | { kind: 'media'; meta: UrlMetadata };

/** Fetch at most MAX_HTML_BYTES of HTML, or classify direct media by
 *  content type without reading the body. Returns null on any error.
 *  Manual redirect handling so each hop's host can be re-checked
 *  through parseAllowedUrl — without per-hop validation, an attacker
 *  controlling a hostname could chain a redirect to http://10.0.0.4/...
 *  and turn this preview endpoint into an internal-network probe.
 *  Same posture as the favicon fetcher (batch 9). */
async function fetchPreviewResource(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<FetchedPreviewResource | null> {
  const MAX_REDIRECTS = 3;
  try {
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!parseAllowedUrl(current)) return null;
      const r = await fetch(current, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
        headers: {
          'user-agent': 'deepmarks-metadata/1.0 (+https://deepmarks.org)',
          'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
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
    const ct = res.headers.get('content-type') ?? '';
    const ctLower = ct.toLowerCase();
    if (ct && !ctLower.includes('text/html') && !ctLower.includes('application/xhtml')) {
      const meta = metadataFromMediaContentType(url, ct);
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return meta ? { kind: 'media', meta } : null;
    }
    // Reject up-front when the server declares a body larger than our cap
    // so we don't consume the full transfer just to discard it.
    const declaredLen = Number.parseInt(res.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLen) && declaredLen > MAX_HTML_BYTES * 4) return null;

    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let received = 0;
    // Enforce an absolute byte budget: if a single chunk would overflow,
    // slice it to the remaining budget. The previous loop only checked
    // `received < MAX` between chunks, so a single 1 MB frame could
    // blow past the 256 KB nominal cap.
    while (received < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_HTML_BYTES - received;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        received = MAX_HTML_BYTES;
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    const buf = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return { kind: 'html', html: new TextDecoder('utf-8', { fatal: false }).decode(buf) };
  } catch {
    return null;
  }
}

export class MetadataStore {
  constructor(private readonly redis: Redis | null) {}

  /**
   * Rate-limit check keyed on the client IP. Returns `ok: false` when the
   * caller has exceeded the window; caller reply 429. Uses INCR + EXPIRE,
   * the classic Redis rate-limit pattern — cheap, no script needed.
   * `retryAfter` is the best estimate of seconds until the window resets
   * (based on TTL).
   */
  async rateLimitCheck(
    clientIp: string,
    limit = METADATA_RATE_LIMIT.limit,
    windowSeconds = METADATA_RATE_LIMIT.windowSeconds,
  ): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
    if (!this.redis) return { ok: true }; // no redis, no rate limit — dev mode
    const key = `dm:rl:metadata:${clientIp}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      // First hit in this window — stamp the TTL.
      await this.redis.expire(key, windowSeconds);
    }
    if (count > limit) {
      const ttl = await this.redis.ttl(key);
      return { ok: false, retryAfter: ttl > 0 ? ttl : windowSeconds };
    }
    return { ok: true };
  }

  /** Look up cached metadata, falling back to a fresh fetch + extract. */
  async resolve(rawUrl: string): Promise<UrlMetadata | null> {
    const parsed = parseAllowedUrl(rawUrl);
    if (!parsed) return null;
    const url = parsed.toString();

    if (this.redis) {
      try {
        const cached = await this.redis.get(REDIS_PREFIX + url);
        if (cached) {
          const data = JSON.parse(cached) as UrlMetadata;
          return data;
        }
      } catch {
        // Cache miss on parse error — fall through to fetch.
      }
    }

    const youtubeMeta = await fetchYoutubeMetadata(url);
    if (youtubeMeta) {
      if (this.redis) {
        try {
          await this.redis.set(REDIS_PREFIX + url, JSON.stringify(youtubeMeta), 'EX', TTL_SECONDS);
        } catch { /* ignore */ }
      }
      return youtubeMeta;
    }

    const fetched = await fetchPreviewResource(url);
    if (!fetched) {
      const stub: UrlMetadata = { url, suggestedTags: [] };
      // Negative-cache the failure for a short window so a broken /
      // non-HTML host isn't re-hammered on every paste.
      if (this.redis) {
        try {
          await this.redis.set(REDIS_PREFIX + url, JSON.stringify(stub), 'EX', NEGATIVE_TTL_SECONDS);
        } catch { /* ignore */ }
      }
      return stub;
    }
    const meta = fetched.kind === 'media' ? fetched.meta : extractMetadata(url, fetched.html);

    if (this.redis) {
      try {
        await this.redis.set(REDIS_PREFIX + url, JSON.stringify(meta), 'EX', TTL_SECONDS);
      } catch {
        // Don't fail the request on a caching hiccup.
      }
    }
    return meta;
  }
}
