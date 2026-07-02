/**
 * YouTube webpage-archive stub.
 *
 * Lifetime webpage archives of YouTube URLs go through the Playwright
 * render path, but YouTube serves a "Sign in to confirm you're not a bot"
 * wall to headless Chromium from a datacenter IP. Actually capturing the
 * watch page is infeasible (it requires authenticating the headless
 * browser, and even then the captured page wouldn't play video). The paid
 * media add-on (`kind:'media'`, 150k sats, yt-dlp + PO token) is the
 * separate path for downloading the actual video file.
 *
 * For the webpage-archive path we instead build a small self-contained
 * HTML "video card" from YouTube's no-auth oEmbed API: title, channel,
 * thumbnail (inlined as a data URI), and a link back to the live page.
 * The archive succeeds, the user keeps their bookmark, and the page no
 * longer fails and pages the operator.
 *
 * Same pattern as tweet-embed.ts. SSRF-safe: the only fetches are to
 * youtube.com/oembed and i.ytimg.com (YouTube's thumbnail CDN).
 */

const OEMBED_ENDPOINT = 'https://www.youtube.com/oembed';
const OEMBED_TIMEOUT_MS = 10_000;
const IMAGE_TIMEOUT_MS = 10_000;
const MAX_API_BYTES = 256 * 1024;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const UA = 'Deepmarks-Archive/1.0 (+https://deepmarks.org/bot)';

// YouTube thumbnail hosts we are willing to fetch + inline. ytimg.com is
// Google's own CDN — never an arbitrary URL from the API.
const YTIMG_HOST_RE = /(^|\.)ytimg\.com$/i;

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

export function isYoutubeVideoUrl(rawUrl: string): boolean {
  return parseYoutubeVideoId(rawUrl) !== null;
}

/** Parse any YouTube URL form (watch, embed, shorts, youtu.be, m.youtube.com,
 *  music.youtube.com) into the 11-char video id, or null if not a single
 *  video. Mirrors api/src/youtube.ts but kept local so the worker has no
 *  cross-package import. */
export function parseYoutubeVideoId(input: string): string | null {
  if (typeof input !== 'string') return null;
  let u: URL;
  try { u = new URL(input.trim()); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname;

  if (host === 'youtu.be') {
    const id = path.slice(1).split('/')[0] ?? '';
    return VIDEO_ID_RE.test(id) ? id : null;
  }
  if (!(host === 'youtube.com' || host.endsWith('.youtube.com'))) return null;

  if (path === '/watch') {
    const v = u.searchParams.get('v') ?? '';
    return VIDEO_ID_RE.test(v) ? v : null;
  }
  const segments = path.split('/').filter(Boolean);
  if (segments.length >= 2) {
    const head = segments[0]!;
    if (head === 'embed' || head === 'shorts' || head === 'v' || head === 'live') {
      const id = segments[1]!;
      return VIDEO_ID_RE.test(id) ? id : null;
    }
  }
  return null;
}

interface FetchDeps {
  fetchImpl?: typeof fetch;
}

interface NormalizedOEmbed {
  title: string;
  authorName: string;
  authorUrl: string;
  thumbnailUrl: string | null;
  type: string;
}

export async function buildYoutubeArchiveHtml(
  rawUrl: string,
  deps: FetchDeps = {},
): Promise<{ html: Buffer; provider: string } | null> {
  const videoId = parseYoutubeVideoId(rawUrl);
  if (!videoId) return null;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const meta = await fetchOEmbed(videoId, fetchImpl);
  if (!meta) return null;
  const html = await renderHtml(meta, videoId, rawUrl, fetchImpl);
  return { html: Buffer.from(html, 'utf-8'), provider: OEMBED_ENDPOINT };
}

async function fetchOEmbed(
  videoId: string,
  fetchImpl: typeof fetch,
): Promise<NormalizedOEmbed | null> {
  const url = `${OEMBED_ENDPOINT}?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`,
  )}&format=json`;
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return null;
    }
    const text = await readBounded(res, MAX_API_BYTES);
    const json = JSON.parse(text) as Record<string, unknown>;
    const title = typeof json.title === 'string' ? json.title : '';
    if (!title) return null;
    return {
      title,
      authorName: typeof json.author_name === 'string' ? json.author_name : '',
      authorUrl: typeof json.author_url === 'string' ? json.author_url : '',
      thumbnailUrl: typeof json.thumbnail_url === 'string' ? json.thumbnail_url : null,
      type: typeof json.type === 'string' ? json.type : 'video',
    };
  } catch {
    return null;
  }
}

async function renderHtml(
  meta: NormalizedOEmbed,
  videoId: string,
  originalUrl: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const thumb = meta.thumbnailUrl ? await inlineImage(meta.thumbnailUrl, fetchImpl) : null;
  // Always show the canonical link — even if the API never gave us a
  // thumbnail, the card still points at the live video.
  const canonical = `https://www.youtube.com/watch?v=${videoId}`;
  const title = meta.title.slice(0, 200);
  const author = meta.authorName
    ? `<a class="author" href="${esc(meta.authorUrl || canonical)}">${esc(meta.authorName)}</a>`
    : '';
  const poster = thumb
    ? `<div class="poster"><img src="${thumb}" alt="${esc(title)}" loading="eager"><div class="play">▶</div></div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; background: #0f0f0f; font: 16px/1.5 Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #f1f1f1; }
  .card { max-width: 720px; margin: 24px auto; background: #212121; border-radius: 12px; overflow: hidden; }
  .poster { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; }
  .poster img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .poster .play { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 64px; color: rgba(255,255,255,0.92); text-shadow: 0 2px 8px rgba(0,0,0,0.6); pointer-events: none; }
  .meta { padding: 16px 20px; }
  .title { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  .author { color: #aaa; text-decoration: none; font-size: 14px; }
  .author:hover { color: #fff; }
  .link { margin-top: 14px; }
  .link a { color: #3ea6ff; text-decoration: none; word-break: break-all; font-size: 14px; }
  footer { padding: 12px 20px; border-top: 1px solid #303030; color: #717171; font-size: 12px; }
</style>
</head>
<body>
<article class="card" data-youtube-id="${esc(videoId)}">
  ${poster}
  <div class="meta">
    <h1 class="title">${esc(title)}</h1>
    ${author}
    <div class="link"><a href="${esc(canonical)}">${esc(canonical)}</a></div>
  </div>
  <footer>
    Source bookmark: <a href="${esc(originalUrl)}" style="color:#717171;text-decoration:none;">${esc(originalUrl)}</a>
    <div>Archived by Deepmarks via the YouTube oEmbed API. Video not embedded — host your own copy? Use the Deepmarks media archive add-on.</div>
  </footer>
</article>
</body>
</html>`;
}

async function inlineImage(rawUrl: string, fetchImpl: typeof fetch): Promise<string | null> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== 'https:' || !YTIMG_HOST_RE.test(u.hostname)) return null;
  try {
    const res = await fetchImpl(u.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      headers: { 'user-agent': UA },
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return null;
    }
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      void res.body?.cancel().catch(() => undefined);
      return null;
    }
    const buf = Buffer.from(await readBoundedBytes(res, MAX_INLINE_IMAGE_BYTES));
    if (buf.byteLength === 0) return null;
    return `data:${contentType.split(';')[0]};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function readBounded(res: Response, maxBytes: number): Promise<string> {
  return new TextDecoder('utf-8', { fatal: false }).decode(await readBoundedBytes(res, maxBytes));
}

async function readBoundedBytes(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - received;
    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    received += chunk.byteLength;
    if (value.byteLength > remaining) break;
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}