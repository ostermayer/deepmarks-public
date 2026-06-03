const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

export type LinkPreviewKind = 'image' | 'video' | 'audio' | 'youtube' | 'page';

export interface LinkPreviewInfo {
  kind: LinkPreviewKind;
  host: string;
  thumbnailUrl?: string;
  youtubeId?: string;
  shouldFetchMetadata: boolean;
}

export function describeLinkPreview(rawUrl: string): LinkPreviewInfo | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const youtubeId = parseYoutubeVideoId(url);
  if (youtubeId) {
    return {
      kind: 'youtube',
      host: 'youtube.com',
      thumbnailUrl: youtubeThumbnailUrl(youtubeId),
      youtubeId,
      shouldFetchMetadata: true,
    };
  }

  const pathname = url.pathname.toLowerCase();
  const host = readableHost(url);
  if (/\.(avif|gif|jpe?g|png|svg|webp)(?:$|[?#])/.test(pathname)) {
    return { kind: 'image', host, thumbnailUrl: url.toString(), shouldFetchMetadata: false };
  }
  if (/\.(m4v|mov|mp4|mpeg|mpg|webm)(?:$|[?#])/.test(pathname)) {
    return { kind: 'video', host, shouldFetchMetadata: false };
  }
  if (/\.(aac|flac|m4a|mp3|ogg|opus|wav)(?:$|[?#])/.test(pathname)) {
    return { kind: 'audio', host, shouldFetchMetadata: false };
  }
  return { kind: 'page', host, shouldFetchMetadata: true };
}

export function isLikelyBlossomBlobUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!url.hostname.toLowerCase().includes('blossom')) return false;
  const lastSegment = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  return /^[a-f0-9]{32,128}$/i.test(lastSegment);
}

export function readableHost(url: URL): string {
  const host = url.host.replace(/^www\./i, '');
  const parts = host.split('.');
  if (parts.length > 2 && (parts[0]?.length ?? 0) > 24) {
    return parts.slice(-2).join('.');
  }
  return host;
}

export function parseYoutubeVideoId(url: URL): string | null {
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

export function youtubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export function youtubeEmbedUrl(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0`;
}
