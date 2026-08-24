import { describe, expect, it } from 'vitest';
import {
  hostOrUrl,
  isLikelyBlossomBlobUrl,
  isMediaContentType,
  mediaKindForContentType,
  safePublicArchiveContentType,
  shouldTryPodcastPage,
} from '@src/media-helpers.js';

describe('media-helpers', () => {
  it('classifies media kind from content type', () => {
    expect(mediaKindForContentType('audio/mpeg')).toBe('audio');
    expect(mediaKindForContentType('image/jpeg')).toBe('image');
    expect(mediaKindForContentType('video/mp4; codecs=avc1')).toBe('video');
    expect(mediaKindForContentType('application/octet-stream')).toBe('video');
  });

  it('detects media content types', () => {
    expect(isMediaContentType('audio/mp4')).toBe(true);
    expect(isMediaContentType('video/webm')).toBe(true);
    expect(isMediaContentType('image/png')).toBe(true);
    expect(isMediaContentType('text/html')).toBe(false);
    expect(isMediaContentType('application/pdf')).toBe(false);
  });

  it('downgrades active SVG to an octet-stream for public serving', () => {
    expect(safePublicArchiveContentType('image/svg+xml')).toBe('application/octet-stream');
    expect(safePublicArchiveContentType('application/pdf')).toBe('application/pdf');
    expect(safePublicArchiveContentType('text/html; charset=utf-8')).toBe('text/html; charset=utf-8');
  });

  it('extracts a clean host (or echoes a non-URL)', () => {
    expect(hostOrUrl('https://www.example.com/path')).toBe('example.com');
    expect(hostOrUrl('not a url')).toBe('not a url');
  });

  it('recognizes Blossom blob URLs by host + 64-hex path', () => {
    expect(isLikelyBlossomBlobUrl(`https://blossom.example.org/${'a'.repeat(64)}`)).toBe(true);
    expect(isLikelyBlossomBlobUrl('https://example.org/not-a-hash')).toBe(false);
  });

  it('tries the podcast page for generic hosts but not known media platforms', () => {
    expect(shouldTryPodcastPage('https://acme.libsyn.com/episode-1')).toBe(true);
    expect(shouldTryPodcastPage('https://www.youtube.com/watch?v=abc')).toBe(false);
    expect(shouldTryPodcastPage('https://x.com/user/status/1')).toBe(false);
  });
});
