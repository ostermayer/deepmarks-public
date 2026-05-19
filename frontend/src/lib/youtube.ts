// YouTube URL canonicalisation. Mirror of payment-proxy/src/youtube.ts —
// both sides need to agree on what counts as a valid YouTube video URL
// and what the canonical 11-character ID is. Kept duplicated rather
// than shared because frontend/payment-proxy don't otherwise share
// code, and the helper is tiny and dependency-free.

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

export function parseYoutubeVideoId(input: string): string | null {
  if (typeof input !== 'string') return null;
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { return null; }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname;

  if (host === 'youtu.be') {
    const id = path.slice(1).split('/')[0] ?? '';
    return VIDEO_ID_RE.test(id) ? id : null;
  }
  if (!(host === 'youtube.com' || host.endsWith('.youtube.com'))) return null;
  if (path === '/watch') {
    const v = url.searchParams.get('v') ?? '';
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

export function canonicalYoutubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
