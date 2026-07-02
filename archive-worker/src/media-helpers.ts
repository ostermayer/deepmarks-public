// Pure helpers for building media archive results and classifying media
// content types / URLs. Extracted from worker.ts so the worker file stays
// the orchestration logic and these stay independently testable.
import type { VideoArchiveResult } from './youtube.js';
import type { DirectFileArchive, DirectFileArchiveOnDisk } from './direct-file.js';

export function resultFromDirectMedia(
  archive: DirectFileArchive,
  sourceUrl: string,
  title = archive.fileName,
): VideoArchiveResult {
  return {
    blob: archive.bytes,
    byteLength: archive.bytes.byteLength,
    title: title || archive.fileName || hostOrUrl(sourceUrl),
    channel: hostOrUrl(sourceUrl),
    durationSeconds: 0,
    mediaKind: mediaKindForContentType(archive.contentType),
    contentType: archive.contentType,
    fileName: archive.fileName,
  };
}

export function resultFromDirectMediaFile(
  archive: DirectFileArchiveOnDisk,
  sourceUrl: string,
  title = archive.fileName,
): VideoArchiveResult {
  return {
    filePath: archive.filePath,
    byteLength: archive.byteLength,
    cleanup: archive.cleanup,
    title: title || archive.fileName || hostOrUrl(sourceUrl),
    channel: hostOrUrl(sourceUrl),
    durationSeconds: 0,
    mediaKind: mediaKindForContentType(archive.contentType),
    contentType: archive.contentType,
    fileName: archive.fileName,
  };
}

export function requiredMediaBuffer(result: VideoArchiveResult): Buffer {
  if (!result.blob) throw new Error('media archive result has no in-memory bytes');
  return result.blob;
}

export function mediaResultByteLength(result: VideoArchiveResult): number {
  return result.byteLength ?? result.blob?.byteLength ?? 0;
}

export function mediaKindForContentType(contentType: string): VideoArchiveResult['mediaKind'] {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('image/')) return 'image';
  return 'video';
}

export function isMediaContentType(contentType: string): boolean {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return normalized.startsWith('audio/') ||
    normalized.startsWith('video/') ||
    normalized.startsWith('image/');
}

export function safePublicArchiveContentType(contentType: string): string {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  // SVG is active content in browsers. Preserve the original type in the
  // archive record, but serve the public blob as a download from Blossom.
  if (normalized === 'image/svg+xml') return 'application/octet-stream';
  return contentType;
}

export function mediaPrimaryFileName(result: VideoArchiveResult): string | undefined {
  return result.fileName;
}

export function isLikelyBlossomBlobUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const path = url.pathname.split('/').filter(Boolean)[0] ?? '';
    return /(^|\.)blossom/i.test(url.hostname) && /^[0-9a-f]{64}$/i.test(path);
  } catch {
    return false;
  }
}

export function shouldTryPodcastPage(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
    return ![
      'youtube.com',
      'youtu.be',
      'vimeo.com',
      'rumble.com',
      'odysee.com',
      'lbry.tv',
      'twitch.tv',
      'tiktok.com',
      'instagram.com',
      'reddit.com',
      'x.com',
      'twitter.com',
      'imgur.com',
    ].some((known) => host === known || host.endsWith(`.${known}`));
  } catch {
    return false;
  }
}

export function hostOrUrl(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return raw;
  }
}
