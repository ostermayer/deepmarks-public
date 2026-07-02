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
// local hostnames, and single-label hosts before fetching. User-controlled
// fetches also DNS-resolve before each hop so public-looking hostnames that
// point at private infrastructure are blocked.
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
import { assertSafeResolvedPublicHttpUrl, safeFetch, type PublicDnsLookup } from './safe-url.js';

const REDIS_PREFIX = 'dm:metadata:';
/** Positive-cache TTL — metadata rarely changes on timescales that matter. */
const TTL_SECONDS = 60 * 60 * 24;
/** Negative-cache TTL — broken hosts (SSL errors, 5xx, non-HTML) shouldn't
 *  be refetched on every paste; short enough that a fixed site reappears
 *  without operator intervention. */
const NEGATIVE_TTL_SECONDS = 10 * 60;
const FETCH_TIMEOUT_MS = 6_000;
const YOUTUBE_OEMBED_TIMEOUT_MS = 3_000;
const OEMBED_TIMEOUT_MS = 3_000;
const CROSSREF_TIMEOUT_MS = 3_000;
const MAX_HTML_BYTES = 256 * 1024; // 256 KB is plenty for <head> + some body
const MAX_OEMBED_BYTES = 96 * 1024;
const MAX_CROSSREF_BYTES = 128 * 1024;
const MAX_SUGGESTED_TAGS = 8;
const MAX_TITLE_LEN = 300;
const MAX_DESCRIPTION_LEN = 500;

/** Default rate-limit window: 20 metadata resolves per IP per minute.
 *  Generous for a legitimate user pasting links; prevents an abuse
 *  script from turning api into an open crawler. */
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
  /** Full-text PDF URL when a scholarly source exposes one in metadata. */
  pdfUrl?: string;
  suggestedTags: string[];
}

export type MetadataFallback = (url: string) => Promise<UrlMetadata | null>;

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
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null;

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

function extractPdfUrl($: cheerio.CheerioAPI, base: URL): string | undefined {
  const selectors = [
    'meta[name="citation_pdf_url"]',
    'meta[name="bepress_citation_pdf_url"]',
    'meta[name="eprints.document_url"]',
    'meta[property="og:pdf"]',
  ];
  for (const selector of selectors) {
    const href = $(selector).attr('content');
    if (!href) continue;
    const safe = safeResolveAssetUrl(href, base);
    if (safe) return safe;
  }

  const linkSelectors = [
    'link[type="application/pdf"]',
    'link[rel~="alternate"][type="application/pdf"]',
    'a[type="application/pdf"]',
    'a[href$=".pdf"]',
    'a[href*=".pdf?"]',
    'a[href*="/pdf/"]',
    'a[href*="/pdf?"]',
  ];
  for (const selector of linkSelectors) {
    const href = $(selector).first().attr('href');
    if (!href) continue;
    const safe = safeResolveAssetUrl(href, base);
    if (safe) return safe;
  }
  return undefined;
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
    $('meta[itemprop="image"]').attr('content'),
    $('link[rel="image_src"]').attr('href'),
  ];
  for (const href of candidates) {
    if (!href) continue;
    const safe = safeResolveAssetUrl(href, base);
    if (safe) return safe;
  }
  return undefined;
}

interface StructuredMetadata {
  title?: string;
  description?: string;
  image?: string;
}

function extractStructuredMetadata($: cheerio.CheerioAPI, base: URL): StructuredMetadata {
  const objects: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).text();
    if (!raw || objects.length >= 80) return;
    try {
      collectJsonObjects(JSON.parse(raw), objects);
    } catch {
      // Invalid structured data is common; social/meta fallbacks still apply.
    }
  });

  const scored = objects
    .map((obj) => ({ obj, score: structuredScore(obj) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const out: StructuredMetadata = {};
  for (const { obj } of scored) {
    out.title ??= cleanText(stringField(obj, ['headline', 'name']), MAX_TITLE_LEN);
    out.description ??= cleanText(stringField(obj, ['description', 'abstract']), MAX_DESCRIPTION_LEN);
    out.image ??= imageField(obj.image ?? obj.thumbnailUrl ?? obj.thumbnail, base);
    if (out.title && out.description && out.image) break;
  }
  return out;
}

function collectJsonObjects(value: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 8 || out.length >= 80) return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonObjects(item, out, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  out.push(record);
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'hasPart']) {
    collectJsonObjects(record[key], out, depth + 1);
  }
}

function structuredScore(obj: Record<string, unknown>): number {
  let score = 0;
  if (stringField(obj, ['headline', 'name'])) score += 2;
  if (stringField(obj, ['description', 'abstract'])) score += 2;
  if (obj.image || obj.thumbnail || obj.thumbnailUrl) score += 1;
  const rawType = obj['@type'];
  const types = Array.isArray(rawType) ? rawType : [rawType];
  if (types.some((type) => typeof type === 'string' && /Article|Posting|WebPage|Product|VideoObject|Recipe|Book/i.test(type))) {
    score += 3;
  }
  return score;
}

function stringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function imageField(value: unknown, base: URL): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return safeResolveAssetUrl(value, base);
  if (Array.isArray(value)) {
    for (const item of value) {
      const image = imageField(item, base);
      if (image) return image;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['url', 'contentUrl', 'thumbnailUrl', 'image']) {
    const image = imageField(record[key], base);
    if (image) return image;
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

export function metadataFromOembed(url: string, body: unknown): UrlMetadata | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const title = cleanText(typeof record.title === 'string' ? record.title : undefined, MAX_TITLE_LEN);
  const author = cleanText(typeof record.author_name === 'string' ? record.author_name : undefined, 120);
  const provider = cleanText(typeof record.provider_name === 'string' ? record.provider_name : undefined, 120);
  const description = cleanText(typeof record.description === 'string' ? record.description : undefined, MAX_DESCRIPTION_LEN)
    ?? (provider && author ? `${provider} by ${author}` : undefined)
    ?? (author ? `by ${author}` : undefined)
    ?? provider;
  const thumbnail = typeof record.thumbnail_url === 'string'
    ? safeResolveAssetUrl(record.thumbnail_url, new URL(url))
    : undefined;
  if (!title && !description && !thumbnail) return null;
  return {
    url,
    title,
    description,
    image: thumbnail,
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

function extractOembedEndpoint(url: string, html: string): string | undefined {
  const $ = cheerio.load(html);
  const base = new URL(url);
  const selectors = [
    'link[rel~="alternate"][type="application/json+oembed"]',
    'link[rel~="alternate"][type="text/json+oembed"]',
  ];
  for (const selector of selectors) {
    const href = $(selector).first().attr('href');
    if (!href) continue;
    const safe = safeResolveAssetUrl(href, base);
    if (safe) return safe;
  }
  return providerOembedEndpoint(url);
}

function providerOembedEndpoint(rawUrl: string): string | undefined {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { return undefined; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const encoded = encodeURIComponent(url.toString());
  if (host === 'vimeo.com' || host === 'player.vimeo.com') return `https://vimeo.com/api/oembed.json?url=${encoded}`;
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return `https://www.tiktok.com/oembed?url=${encoded}`;
  if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) return `https://soundcloud.com/oembed?format=json&url=${encoded}`;
  if (host === 'spotify.com' || host === 'open.spotify.com') return `https://open.spotify.com/oembed?url=${encoded}`;
  return undefined;
}

async function fetchOembedMetadata(
  url: string,
  html: string,
  dnsLookup?: PublicDnsLookup,
): Promise<UrlMetadata | null> {
  const endpoint = extractOembedEndpoint(url, html);
  if (!endpoint) return null;
  try {
    // The oEmbed endpoint is attacker-declared (page `<link rel=oembed>`),
    // so it must be validated per-hop and IP-pinned exactly like the main
    // preview fetch. The previous single `fetch(endpoint)` used the default
    // redirect:'follow', so a validated endpoint could 30x to an internal
    // target with no re-check — SSRF reachable unauthenticated via /metadata.
    const MAX_REDIRECTS = 3;
    let current = endpoint;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!parseAllowedUrl(current)) return null;
      const r = await safeFetch(current, {
        signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
        redirect: 'manual',
        headers: {
          'accept': 'application/json',
          'user-agent': 'deepmarks-metadata/1.0 (+https://deepmarks.org)',
        },
      }, { dnsLookup });
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
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (received < MAX_OEMBED_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_OEMBED_BYTES - received;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        received = MAX_OEMBED_BYTES;
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    const buf = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(buf));
    return metadataFromOembed(url, body);
  } catch {
    return null;
  }
}

function extractTitle($: cheerio.CheerioAPI, structured: StructuredMetadata): string | undefined {
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
  const itemprop = $('meta[itemprop="name"], meta[itemprop="headline"]').attr('content');
  if (itemprop) {
    const t = cleanText(itemprop, MAX_TITLE_LEN);
    if (t) return t;
  }
  const namedTitle = $('meta[name="title"]').attr('content');
  if (namedTitle) {
    const t = cleanText(namedTitle, MAX_TITLE_LEN);
    if (t) return t;
  }
  if (structured.title) return structured.title;
  const title = $('title').first().text();
  const cleanedTitle = cleanText(title, MAX_TITLE_LEN);
  if (cleanedTitle) return cleanedTitle;
  return cleanText($('h1').first().text(), MAX_TITLE_LEN);
}

function extractDescription($: cheerio.CheerioAPI, structured: StructuredMetadata): string | undefined {
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
  const cleanedMeta = cleanText(meta, MAX_DESCRIPTION_LEN);
  if (cleanedMeta) return cleanedMeta;
  const itemprop = $('meta[itemprop="description"]').attr('content');
  const cleanedItemprop = cleanText(itemprop, MAX_DESCRIPTION_LEN);
  if (cleanedItemprop) return cleanedItemprop;
  if (structured.description) return structured.description;
  return extractParagraphDescription($);
}

function extractParagraphDescription($: cheerio.CheerioAPI): string | undefined {
  const selectors = ['article p', 'main p', '[itemprop="articleBody"] p', 'p'];
  for (const selector of selectors) {
    const paragraphs = $(selector).toArray();
    for (const el of paragraphs) {
      const text = cleanText($(el).text(), MAX_DESCRIPTION_LEN);
      if (!text || text.length < 80) continue;
      if (/^(cookie|subscribe|sign up|advertisement)\b/i.test(text)) continue;
      return text;
    }
  }
  return undefined;
}

function mergeMetadata(primary: UrlMetadata, fallback: UrlMetadata | null): UrlMetadata {
  if (!fallback) return primary;
  return {
    ...primary,
    title: primary.title ?? fallback.title,
    description: primary.description ?? fallback.description,
    image: primary.image ?? fallback.image,
    favicon: primary.favicon ?? fallback.favicon,
    lightning: primary.lightning ?? fallback.lightning,
    mediaKind: primary.mediaKind ?? fallback.mediaKind,
    contentType: primary.contentType ?? fallback.contentType,
    pdfUrl: primary.pdfUrl ?? fallback.pdfUrl,
    suggestedTags: primary.suggestedTags.length > 0 ? primary.suggestedTags : fallback.suggestedTags,
  };
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

export function extractDoiFromUrl(rawUrl: string): string | null {
  return extractDoiCandidatesFromUrl(rawUrl)[0] ?? null;
}

function extractDoiCandidatesFromUrl(rawUrl: string): string[] {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { return []; }

  const candidates: string[] = [];
  const add = (raw: string | null | undefined): void => {
    const normalized = normalizeDoi(raw);
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };

  const doiParam = url.searchParams.get('doi') ?? url.searchParams.get('DOI');
  add(doiParam);

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = safeDecodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (host === 'doi.org' || host === 'dx.doi.org') {
    add(path);
  }

  const doiPathIndex = path.toLowerCase().indexOf('doi/');
  if (doiPathIndex >= 0) {
    const afterDoi = path.slice(doiPathIndex + 4);
    const parts = afterDoi.split('/').filter(Boolean);
    if (parts.length >= 3 && /^10\.\d{4,9}$/i.test(parts[0]!)) {
      // Publisher article URLs often append a site-local numeric id
      // after the DOI. Keep the DOI prefix plus the first two suffix
      // segments, which covers Oxford URLs such as
      // /doi/10.1093/biosci/biaf050/8116758.
      add(parts.slice(0, 3).join('/'));
      for (let end = parts.length; end > 3; end -= 1) {
        add(parts.slice(0, end).join('/'));
      }
    }
  }

  const match = path.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  add(match?.[0]);
  return candidates;
}

async function fetchCrossrefMetadata(url: string): Promise<UrlMetadata | null> {
  for (const doi of extractDoiCandidatesFromUrl(url)) {
    const endpoint = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
    try {
      const res = await fetch(endpoint, {
        signal: AbortSignal.timeout(CROSSREF_TIMEOUT_MS),
        headers: {
          'accept': 'application/json',
          'user-agent': 'deepmarks-metadata/1.0 (+https://deepmarks.org)',
        },
      });
      if (!res.ok) continue;
      const reader = res.body?.getReader();
      if (!reader) continue;
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (received < MAX_CROSSREF_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = MAX_CROSSREF_BYTES - received;
        if (value.byteLength > remaining) {
          chunks.push(value.slice(0, remaining));
          received = MAX_CROSSREF_BYTES;
          break;
        }
        chunks.push(value);
        received += value.byteLength;
      }
      try { await reader.cancel(); } catch { /* ignore */ }
      const buf = new Uint8Array(received);
      let off = 0;
      for (const chunk of chunks) { buf.set(chunk, off); off += chunk.byteLength; }
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(buf)) as unknown;
      const meta = crossrefMetadataFromResponse(url, doi, parsed);
      if (meta) return meta;
    } catch {
      continue;
    }
  }
  return null;
}

export function crossrefMetadataFromResponse(url: string, doi: string, response: unknown): UrlMetadata | null {
  if (!response || typeof response !== 'object') return null;
  const message = (response as Record<string, unknown>).message;
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  const title = cleanText(htmlToText(firstString(record.title)), MAX_TITLE_LEN);
  const subtitle = cleanText(htmlToText(firstString(record.subtitle)), MAX_TITLE_LEN);
  const abstract = cleanText(htmlToText(typeof record.abstract === 'string' ? record.abstract : undefined), MAX_DESCRIPTION_LEN);
  const container = cleanText(firstString(record['container-title']), 160);
  const published = crossrefPublishedYear(record);
  const description = abstract
    ?? cleanText([container, published ? String(published) : undefined, `DOI ${doi}`].filter(Boolean).join(' · '), MAX_DESCRIPTION_LEN);
  const suggestedTags = crossrefSuggestedTags(record);
  if (!title && !description && suggestedTags.length === 0) return null;
  return {
    url,
    title: subtitle && title ? `${title}: ${subtitle}` : title,
    description,
    suggestedTags,
  };
}

function crossrefSuggestedTags(record: Record<string, unknown>): string[] {
  const raw = [
    'scholarly',
    ...arrayStrings(record.subject),
    typeof record.type === 'string' ? record.type : '',
  ];
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

function crossrefPublishedYear(record: Record<string, unknown>): number | undefined {
  const candidates = [
    record.published,
    record['published-print'],
    record['published-online'],
    record.issued,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const parts = (candidate as Record<string, unknown>)['date-parts'];
    if (!Array.isArray(parts) || !Array.isArray(parts[0])) continue;
    const year = parts[0][0];
    if (typeof year === 'number' && Number.isInteger(year) && year > 0) return year;
  }
  return undefined;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === 'string');
  return undefined;
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function htmlToText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return cheerio.load(`<body>${value}</body>`).text();
}

function normalizeDoi(value: string | null | undefined): string | null {
  const decoded = safeDecodeURIComponent(value ?? '').trim();
  if (!decoded) return null;
  const withoutUrlPrefix = decoded
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');
  const match = withoutUrlPrefix.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  if (!match) return null;
  return match[0].replace(/[).,;:\]\s]+$/g, '').toLowerCase();
}

function safeDecodeURIComponent(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

/**
 * Parse already-fetched HTML into a UrlMetadata. Exposed so tests can
 * verify the extraction logic without touching the network.
 */
export function extractMetadata(url: string, html: string): UrlMetadata {
  const $ = cheerio.load(html);
  const base = new URL(url);
  const structured = extractStructuredMetadata($, base);
  return {
    url,
    title: extractTitle($, structured),
    description: extractDescription($, structured),
    image: extractImage($, base) ?? structured.image,
    favicon: extractFavicon($, base),
    lightning: extractLightning($),
    pdfUrl: extractPdfUrl($, base),
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
async function fetchPreviewResource(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS,
  dnsLookup?: PublicDnsLookup,
): Promise<FetchedPreviewResource | null> {
  const MAX_REDIRECTS = 3;
  try {
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!parseAllowedUrl(current)) return null;
      // safeFetch pins the validated IP into the connect (DNS-rebinding guard).
      const r = await safeFetch(current, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
        headers: {
          'user-agent': 'deepmarks-metadata/1.0 (+https://deepmarks.org)',
          'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        },
      }, { dnsLookup });
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
  constructor(
    private readonly redis: Redis | null,
    private readonly blockedFetchFallback?: MetadataFallback,
    private readonly dnsLookup?: PublicDnsLookup,
  ) {}

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
          if (!hasUsefulMetadata(data)) {
            const fallback = await this.resolveBlockedMetadata(url);
            if (fallback) {
              await this.cacheMetadata(url, fallback, TTL_SECONDS);
              return fallback;
            }
          }
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

    const fetched = await fetchPreviewResource(url, FETCH_TIMEOUT_MS, this.dnsLookup);
    if (!fetched) {
      const fallback = await this.resolveBlockedMetadata(url);
      if (fallback) {
        await this.cacheMetadata(url, fallback, TTL_SECONDS);
        return fallback;
      }
      const stub: UrlMetadata = { url, suggestedTags: [] };
      // Negative-cache the failure for a short window so a broken /
      // non-HTML host isn't re-hammered on every paste.
      await this.cacheMetadata(url, stub, NEGATIVE_TTL_SECONDS);
      return stub;
    }
    const meta = fetched.kind === 'media'
      ? fetched.meta
      : mergeMetadata(extractMetadata(url, fetched.html), await fetchOembedMetadata(url, fetched.html, this.dnsLookup));

    await this.cacheMetadata(url, meta, TTL_SECONDS);
    return meta;
  }

  private async resolveBlockedMetadata(url: string): Promise<UrlMetadata | null> {
    const existingBookmark = await this.resolveBlockedFetchFallback(url);
    if (existingBookmark) return existingBookmark;
    return fetchCrossrefMetadata(url);
  }

  private async resolveBlockedFetchFallback(url: string): Promise<UrlMetadata | null> {
    if (!this.blockedFetchFallback) return null;
    try {
      const meta = await this.blockedFetchFallback(url);
      if (!meta || !hasUsefulMetadata(meta)) return null;
      return {
        ...meta,
        url,
        suggestedTags: Array.from(new Set(meta.suggestedTags ?? [])).slice(0, MAX_SUGGESTED_TAGS),
      };
    } catch {
      return null;
    }
  }

  private async cacheMetadata(url: string, meta: UrlMetadata, ttlSeconds: number): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(REDIS_PREFIX + url, JSON.stringify(meta), 'EX', ttlSeconds);
    } catch {
      // Don't fail the request on a caching hiccup.
    }
  }
}

function hasUsefulMetadata(meta: UrlMetadata): boolean {
  return !!(
    meta.title ||
    meta.description ||
    meta.image ||
    meta.favicon ||
    meta.lightning ||
    meta.mediaKind ||
    meta.contentType ||
    meta.pdfUrl ||
    (meta.suggestedTags?.length ?? 0) > 0
  );
}
