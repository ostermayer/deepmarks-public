// ═══════════════════════════════════════════════════════════════════════
// CANONICAL SOURCE — packages/youtube-id/youtube-id.ts
//
// YouTube video-ID recognition, shared by api, archive-worker, frontend,
// and browser-extension. The parser existed five times (plus host
// predicates and inline ID regexes) and had genuinely drifted: the
// frontend/extension media-archive copies accepted `?v=<id>` on ANY
// youtube.com path (so a playlist URL could be misdetected as a single
// video, disagreeing with the server's parser), lacked the `/v/<id>`
// form, and differed on a youtu.be edge case. The canonical semantics
// below are the server's — the api decides what may enter the media
// queue, so every surface must recognize exactly what it does
// (2026-08-23 review, simplification backlog).
//
// Edit THIS file, then run:  node scripts/sync-shared-modules.mjs
// which regenerates the checked-in copies (Docker/site build contexts
// are per-package, so a runtime workspace dependency can't reach the
// builds — generated copies + parity tests give one source of truth
// without touching any build system). The api and archive-worker
// parity suites check every copy, including the frontend/extension
// ones.
//
// We only accept the YouTube-Video-ID space (11 chars from a base64-URL
// alphabet). No playlist IDs, no channel IDs — those don't map to a
// single archivable video and must not enter the queue.
// ═══════════════════════════════════════════════════════════════════════

export const YOUTUBE_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/** Type guard for a bare 11-char YouTube video ID. */
export function isYoutubeVideoId(value: unknown): value is string {
  return typeof value === 'string' && YOUTUBE_VIDEO_ID_RE.test(value);
}

/** One definition of "a YouTube host" for every surface — the renderer's
 *  bot-wall gate once used its own regex, which drifted from the parser.
 *  Deliberately the primary domains only: parseYoutubeVideoId ALSO
 *  accepts the youtube-nocookie.com embed domain, but the host gates
 *  (renderer bot-wall, media-URL detection) keep their pre-unification
 *  scope. */
export function isYoutubeHost(hostname: string): boolean {
  // Strip www. so the gate can never disagree with the parser on a
  // host the parser accepts (www.youtu.be regressed exactly this way
  // when a www-stripping local copy was replaced with this predicate).
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
}

/**
 * Extract the 11-char video ID from any YouTube URL form — youtu.be/<id>,
 * *.youtube.com (www, m, music, gaming) /watch?v=<id>, /embed/<id>,
 * /shorts/<id>, /v/<id>, /live/<id> — or return null if the URL doesn't
 * represent a single video. Accepts a string (never throws — a malformed
 * URL is just null) or an already-parsed URL.
 */
export function parseYoutubeVideoId(input: string | URL): string | null {
  let url: URL;
  if (input instanceof URL) {
    url = input;
  } else {
    if (typeof input !== 'string') return null;
    try { url = new URL(input.trim()); } catch { return null; }
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname;

  // youtu.be/<id>
  if (host === 'youtu.be') {
    const id = path.slice(1).split('/')[0] ?? '';
    return YOUTUBE_VIDEO_ID_RE.test(id) ? id : null;
  }

  // Accept any *.youtube.com subdomain (music, gaming, m, www) plus the
  // youtube-nocookie.com embed domain.
  if (!(
    host === 'youtube.com' || host.endsWith('.youtube.com')
    || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')
  )) return null;

  // /watch?v=<id> — the path must BE /watch; a `v` param on any other
  // path (e.g. /playlist?v=...) is not a single-video URL.
  if (path === '/watch') {
    const v = url.searchParams.get('v') ?? '';
    return YOUTUBE_VIDEO_ID_RE.test(v) ? v : null;
  }

  // /embed/<id>, /shorts/<id>, /v/<id>, /live/<id>
  const segments = path.split('/').filter(Boolean);
  if (segments.length >= 2) {
    const head = segments[0]!;
    if (head === 'embed' || head === 'shorts' || head === 'v' || head === 'live') {
      const id = segments[1]!;
      return YOUTUBE_VIDEO_ID_RE.test(id) ? id : null;
    }
  }

  return null;
}

/** True when the URL parses to a single YouTube video. */
export function isYoutubeVideoUrl(rawUrl: string): boolean {
  return parseYoutubeVideoId(rawUrl) !== null;
}
