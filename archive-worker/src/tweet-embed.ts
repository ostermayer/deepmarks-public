/**
 * Tweet archiving via the FixTweet / FxEmbed status API.
 *
 * X/Twitter renders a tweet as an empty JavaScript shell that SingleFile
 * cannot capture, and the public Nitter mirror ecosystem is effectively dead
 * (rate-limited / blocked / empty — probed June 2026). The FixTweet API
 * (api.fxtwitter.com, also api.fixupx.com) returns the full tweet as JSON
 * with no credentials, which we turn into a self-contained, archival HTML
 * page: text + author + media inlined as data URIs, so the archive survives
 * even if Twitter's CDN later disappears.
 *
 * Docs: https://docs.fxtwitter.com/en/latest/api/status.html
 */

// FixTweet-compatible providers (same JSON shape). Tried in order.
const PROVIDERS = ['https://api.fxtwitter.com', 'https://api.fixupx.com'] as const;
// FixTweet asks callers to identify themselves in the User-Agent.
const UA = 'Deepmarks-Archive/1.0 (+https://deepmarks.org/bot)';
const API_TIMEOUT_MS = 12_000;
const IMAGE_TIMEOUT_MS = 10_000;
const MAX_API_BYTES = 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_IMAGES = 8;
// Media/avatar URLs we are willing to fetch+inline — Twitter's own CDNs only.
const TWIMG_HOST_RE = /(^|\.)twimg\.com$/i;

export interface TweetParts {
  screenName: string;
  id: string;
}

// Hosts whose /<user>/status/<id> URLs are tweets we rebuild via FixTweet.
// Beyond x.com / twitter.com we accept the Nitter-family mirror hosts: a
// rescue candidate (or a directly-bookmarked link) can point at a Nitter /
// xcancel mirror, and because we rebuild from the FixTweet API *by status id*
// — never by fetching the mirror host — recognizing them here lets those
// archive cleanly instead of rendering a dead mirror page. Matching on the
// host is SSRF-safe for the same reason: the host is only used to detect a
// tweet and read its id; the only requests we make are to FixTweet + twimg.
const TWEET_HOSTS = new Set([
  'x.com', 'twitter.com', 'mobile.twitter.com', 'xcancel.com', 'nitter.net',
]);

function isTweetHost(hostname: string): boolean {
  const host = hostname.replace(/^www\./i, '').toLowerCase();
  // Known x/twitter + named mirrors, plus any nitter.* instance.
  return TWEET_HOSTS.has(host) || /(^|\.)nitter\./i.test(host);
}

/** Parse an x.com / twitter.com / Nitter-mirror tweet URL into a screen name +
 *  status id (the id is all FixTweet needs to rebuild the tweet). */
export function parseTweetUrl(rawUrl: string): TweetParts | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isTweetHost(u.hostname)) return null;
  const idMatch = u.pathname.match(/\/status(?:es)?\/(\d{5,25})/);
  if (!idMatch) return null;
  const nameMatch = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status/);
  return { screenName: nameMatch?.[1] ?? 'i', id: idMatch[1]! };
}

export function isTweetUrl(rawUrl: string): boolean {
  return parseTweetUrl(rawUrl) !== null;
}

interface NormalizedMedia {
  type: string;
  imageUrl: string | null;
  videoUrl: string | null;
}

interface NormalizedTweet {
  provider: string;
  url: string;
  text: string;
  createdAt: string | null;
  author: { name: string; screenName: string; avatarUrl: string | null; verified: boolean };
  media: NormalizedMedia[];
  stats: { likes?: number; retweets?: number; replies?: number; views?: number };
  quote: { name: string; screenName: string; text: string } | null;
}

interface FetchDeps {
  fetchImpl?: typeof fetch;
}

/**
 * Build a self-contained archival HTML page for a tweet, or null if the URL
 * isn't a tweet / no provider could serve it.
 */
export async function buildTweetArchiveHtml(
  rawUrl: string,
  deps: FetchDeps = {},
): Promise<{ html: Buffer; provider: string } | null> {
  const parts = parseTweetUrl(rawUrl);
  if (!parts) return null;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const tweet = await fetchTweet(parts, fetchImpl);
  if (!tweet) return null;
  const html = await renderTweetHtml(tweet, rawUrl, fetchImpl);
  return { html: Buffer.from(html, 'utf-8'), provider: tweet.provider };
}

/**
 * Resolve a tweet URL to its direct video.twimg.com mp4 (or null). yt-dlp can
 * no longer pull video from x.com, but it downloads the direct mp4 fine — so
 * the media path resolves the tweet through the FixTweet API and feeds yt-dlp
 * the direct file instead. Constrained to Twitter's own video CDN.
 */
export async function resolveTweetVideoUrl(rawUrl: string, deps: FetchDeps = {}): Promise<string | null> {
  const parts = parseTweetUrl(rawUrl);
  if (!parts) return null;
  const tweet = await fetchTweet(parts, deps.fetchImpl ?? fetch);
  if (!tweet) return null;
  for (const m of tweet.media) {
    if (!m.videoUrl) continue;
    try {
      const u = new URL(m.videoUrl);
      if (u.protocol === 'https:' && TWIMG_HOST_RE.test(u.hostname)) return m.videoUrl;
    } catch {
      // skip malformed media URL
    }
  }
  return null;
}

async function fetchTweet(parts: TweetParts, fetchImpl: typeof fetch): Promise<NormalizedTweet | null> {
  for (const base of PROVIDERS) {
    try {
      const res = await fetchImpl(`${base}/${parts.screenName}/status/${parts.id}`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
        headers: { 'user-agent': UA, accept: 'application/json' },
      });
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        continue;
      }
      const text = await readBounded(res, MAX_API_BYTES);
      const json = JSON.parse(text) as unknown;
      const norm = normalize(json, base);
      if (norm) return norm;
    } catch {
      // try the next provider
    }
  }
  return null;
}

const MAX_VIDEO_RES = 720; // archive cap — never pull 1080p+ tweet video, matching the YouTube 720p policy

/** Pick the highest mp4 variant whose smaller dimension is <= maxRes (the
 *  "p" resolution, so portrait 720p is kept). Twitter serves up to 1080p;
 *  resolution is read from the variant URL path (/<w>x<h>/). Falls back to
 *  the media's default url when no variant qualifies. */
function pickCappedVideoUrl(m: Record<string, unknown>, maxRes: number): string | null {
  let best: { url: string; res: number } | null = null;
  for (const v of (m.variants as Record<string, unknown>[]) ?? []) {
    if (!String(v.content_type ?? '').includes('mp4')) continue;
    const url = v.url as string | undefined;
    const dims = url?.match(/\/(\d+)x(\d+)\//);
    const res = dims ? Math.min(Number(dims[1]), Number(dims[2])) : 0;
    if (!url || res === 0 || res > maxRes) continue;
    if (!best || res > best.res) best = { url, res };
  }
  return best?.url ?? ((m.url as string) ?? null);
}

function normalize(json: unknown, provider: string): NormalizedTweet | null {
  const root = json as Record<string, unknown>;
  const t = root?.tweet as Record<string, unknown> | undefined;
  if (!t) return null;
  const text = (t.text as string) ?? (t.raw_text as string) ?? '';
  if (!text && !t.media) return null;
  const a = (t.author as Record<string, unknown>) ?? {};
  const mediaAll = (((t.media as Record<string, unknown>)?.all as Record<string, unknown>[]) ?? []);
  const verification = a.verification;
  const quote = t.quote as Record<string, unknown> | undefined;
  const quoteAuthor = (quote?.author as Record<string, unknown>) ?? {};
  return {
    provider,
    url: (t.url as string) ?? '',
    text,
    createdAt: (t.created_at as string) ?? null,
    author: {
      name: (a.name as string) ?? (a.screen_name as string) ?? 'unknown',
      screenName: (a.screen_name as string) ?? '',
      avatarUrl: (a.avatar_url as string) ?? null,
      verified: Boolean(verification) && verification !== 'none',
    },
    media: mediaAll.map((m) => {
      const type = (m.type as string) ?? 'photo';
      return {
        type,
        imageUrl: type === 'photo' ? ((m.url as string) ?? null) : ((m.thumbnail_url as string) ?? null),
        videoUrl: type === 'video' || type === 'gif' ? pickCappedVideoUrl(m, MAX_VIDEO_RES) : null,
      };
    }),
    stats: {
      likes: t.likes as number | undefined,
      retweets: t.retweets as number | undefined,
      replies: t.replies as number | undefined,
      views: t.views as number | undefined,
    },
    quote: quote
      ? {
          name: (quoteAuthor.name as string) ?? '',
          screenName: (quoteAuthor.screen_name as string) ?? '',
          text: (quote.text as string) ?? (quote.raw_text as string) ?? '',
        }
      : null,
  };
}

async function renderTweetHtml(tweet: NormalizedTweet, originalUrl: string, fetchImpl: typeof fetch): Promise<string> {
  const avatar = tweet.author.avatarUrl ? await inlineImage(tweet.author.avatarUrl, fetchImpl) : null;
  const photos: string[] = [];
  let videoNote = '';
  let inlined = 0;
  for (const m of tweet.media) {
    if (inlined >= MAX_INLINE_IMAGES) break;
    if (m.imageUrl) {
      const data = await inlineImage(m.imageUrl, fetchImpl);
      if (data) {
        inlined += 1;
        const isVideoPoster = m.type !== 'photo';
        photos.push(
          `<figure class="media${isVideoPoster ? ' video' : ''}"><img src="${data}" alt="tweet media" loading="eager">` +
            (isVideoPoster ? '<figcaption>▶ video</figcaption>' : '') +
            '</figure>',
        );
      }
    }
    if (m.videoUrl) videoNote = `<p class="video-link">video: <a href="${esc(m.videoUrl)}">${esc(m.videoUrl)}</a></p>`;
  }

  const verifiedBadge = tweet.author.verified ? ' <span class="verified" title="verified">✓</span>' : '';
  const handle = tweet.author.screenName ? `@${esc(tweet.author.screenName)}` : '';
  const title = `${tweet.author.name} (${handle}): ${tweet.text}`.slice(0, 140);
  const quote = tweet.quote
    ? `<blockquote class="quote"><div class="q-author">${esc(tweet.quote.name)} <span>@${esc(tweet.quote.screenName)}</span></div><div class="q-text">${textToHtml(tweet.quote.text)}</div></blockquote>`
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
  body { margin: 0; background: #f7f9f9; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #0f1419; }
  .tweet { max-width: 600px; margin: 24px auto; background: #fff; border: 1px solid #cfd9de; border-radius: 16px; padding: 16px 20px; }
  .head { display: flex; align-items: center; gap: 12px; }
  .avatar { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; background: #e1e8ed; flex: none; }
  .who { display: flex; flex-direction: column; line-height: 1.2; }
  .name { font-weight: 700; }
  .handle { color: #536471; }
  .verified { color: #1d9bf0; }
  .text { margin: 14px 0; font-size: 18px; white-space: pre-wrap; word-wrap: break-word; }
  .media { margin: 12px 0; }
  .media img { max-width: 100%; border-radius: 14px; border: 1px solid #cfd9de; display: block; }
  .media.video { position: relative; }
  .media figcaption { color: #536471; font-size: 14px; margin-top: 4px; }
  .quote { margin: 12px 0; padding: 10px 14px; border: 1px solid #cfd9de; border-radius: 14px; }
  .q-author { font-weight: 600; } .q-author span { color: #536471; font-weight: 400; }
  .video-link { font-size: 14px; word-break: break-all; }
  footer { margin-top: 14px; padding-top: 12px; border-top: 1px solid #eff3f4; color: #536471; font-size: 14px; }
  footer a { color: #1d9bf0; }
  .stats { margin: 6px 0; }
</style>
</head>
<body>
<article class="tweet">
  <div class="head">
    ${avatar ? `<img class="avatar" src="${avatar}" alt="">` : '<div class="avatar"></div>'}
    <div class="who">
      <span class="name">${esc(tweet.author.name)}${verifiedBadge}</span>
      <span class="handle">${esc(handle)}</span>
    </div>
  </div>
  <div class="text">${textToHtml(tweet.text)}</div>
  ${quote}
  ${photos.join('\n  ')}
  ${videoNote}
  <footer>
    ${tweet.createdAt ? `<time>${esc(tweet.createdAt)}</time>` : ''}
    <div class="stats">${formatStats(tweet.stats)}</div>
    <a href="${esc(originalUrl)}">${esc(originalUrl)}</a>
    <div>archived by Deepmarks via the FixTweet API</div>
  </footer>
</article>
</body>
</html>`;
}

function formatStats(s: NormalizedTweet['stats']): string {
  const parts: string[] = [];
  if (s.replies != null) parts.push(`💬 ${s.replies.toLocaleString('en-US')}`);
  if (s.retweets != null) parts.push(`🔁 ${s.retweets.toLocaleString('en-US')}`);
  if (s.likes != null) parts.push(`❤ ${s.likes.toLocaleString('en-US')}`);
  if (s.views != null) parts.push(`👁 ${s.views.toLocaleString('en-US')}`);
  return parts.join(' · ');
}

async function inlineImage(rawUrl: string, fetchImpl: typeof fetch): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  // Only fetch from Twitter's own CDNs — never an arbitrary URL from the API.
  if (u.protocol !== 'https:' || !TWIMG_HOST_RE.test(u.hostname)) return null;
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

/** Escape, then turn newlines into <br> and bare URLs into links. */
function textToHtml(s: string): string {
  const escaped = esc(s);
  const linked = escaped.replace(/https?:\/\/[^\s<]+/g, (m) => `<a href="${m}">${m}</a>`);
  return linked.replace(/\n/g, '<br>');
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
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
