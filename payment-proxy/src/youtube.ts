// YouTube URL canonicalisation.
//
// The same video has many URL forms — youtube.com/watch?v=ID,
// youtu.be/ID, youtube.com/embed/ID, youtube.com/shorts/ID,
// music.youtube.com/watch?v=ID, with optional &t=, &si=, &list=
// query parameters. Dedup needs them all to collapse to one
// canonical 11-character video ID so the refcount system treats
// them as the same content.
//
// We only accept the YouTube-Video-ID space (11 chars from a base64-
// URL alphabet). No playlist IDs, no channel IDs — those don't map
// to a single archivable video and shouldn't enter the queue.

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Extract the 11-char video ID from any YouTube URL form, or return
 * null if the URL doesn't represent a single video. Never throws —
 * a malformed URL is just `null`.
 */
export function parseYoutubeVideoId(input: string): string | null {
  if (typeof input !== 'string') return null;
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { return null; }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname;

  // youtu.be/<id>
  if (host === 'youtu.be') {
    const id = path.slice(1).split('/')[0] ?? '';
    return VIDEO_ID_RE.test(id) ? id : null;
  }

  // Accept any *.youtube.com subdomain (music, gaming, m, www).
  if (!(host === 'youtube.com' || host.endsWith('.youtube.com'))) return null;

  // /watch?v=<id>
  if (path === '/watch') {
    const v = url.searchParams.get('v') ?? '';
    return VIDEO_ID_RE.test(v) ? v : null;
  }

  // /embed/<id>, /shorts/<id>, /v/<id>, /live/<id>
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

/** Canonical content key used by the refcount module — collapses
 *  every URL form of the same video into one dedup bucket. */
export function videoContentKey(videoId: string): string {
  return `yt:${videoId.toLowerCase()}`;
}

/** Stable canonical URL we hand to yt-dlp. Always the long form so
 *  the worker's logs and the archived metadata reference the
 *  unambiguous URL even if the user pasted a youtu.be short link. */
export function canonicalYoutubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
