import { createHash } from 'node:crypto';
import { validateSafePublicHttpUrl } from './safe-url.js';
import { canonicalYoutubeUrl, parseYoutubeVideoId, videoContentKey } from './youtube.js';

/** Paid media archive purchase. Pricier than a webpage archive because
 * yt-dlp downloads optional muxed video/audio or podcast audio and the encrypted blob is
 * materially larger than a SingleFile HTML snapshot. */
export const VIDEO_ARCHIVE_COST_SATS = 150_000;

export interface NormalizedVideoArchiveInput {
  url: string;
  contentKey: string;
  videoId?: string;
}

export function normalizeVideoArchiveInput(raw: string): NormalizedVideoArchiveInput {
  const videoId = parseYoutubeVideoId(raw);
  if (videoId) {
    return {
      url: canonicalYoutubeUrl(videoId),
      contentKey: videoContentKey(videoId),
      videoId,
    };
  }

  const url = validateSafePublicHttpUrl(raw);
  if (isYoutubeHost(url)) {
    throw new Error('youtube media archive requires a video URL');
  }
  url.hash = '';
  return {
    url: url.toString(),
    contentKey: `video:${sha256Hex(url.toString())}`,
  };
}

function isYoutubeHost(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
