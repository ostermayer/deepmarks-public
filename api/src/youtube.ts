// YouTube URL canonicalisation.
//
// The same video has many URL forms — youtube.com/watch?v=ID,
// youtu.be/ID, youtube.com/embed/ID, youtube.com/shorts/ID,
// music.youtube.com/watch?v=ID, with optional &t=, &si=, &list=
// query parameters. The video archive flow uses a canonical
// 11-character video ID for metadata and stable source keys.
//
// We only accept the YouTube-Video-ID space (11 chars from a base64-
// URL alphabet). No playlist IDs, no channel IDs — those don't map
// to a single archivable video and shouldn't enter the queue.

// The parser itself is shared with every other surface via the
// generated youtube-id module — edit packages/youtube-id/youtube-id.ts,
// never the copy.
export { isYoutubeVideoId, parseYoutubeVideoId, YOUTUBE_VIDEO_ID_RE } from './youtube-id.js';

/** Canonical source key for metadata and future grouping. */
export function videoContentKey(videoId: string): string {
  return `yt:${videoId.toLowerCase()}`;
}

/** Stable canonical URL we hand to yt-dlp. Always the long form so
 *  the worker's logs and the archived metadata reference the
 *  unambiguous URL even if the user pasted a youtu.be short link. */
export function canonicalYoutubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
