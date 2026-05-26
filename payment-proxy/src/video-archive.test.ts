import { describe, expect, it } from 'vitest';
import { normalizeVideoArchiveInput, VIDEO_ARCHIVE_COST_SATS } from './video-archive.js';

describe('normalizeVideoArchiveInput', () => {
  it('canonicalizes YouTube URLs to a stable video content key', () => {
    const normalized = normalizeVideoArchiveInput('https://youtu.be/abcDEF123_4?t=10');
    expect(normalized).toEqual({
      url: 'https://www.youtube.com/watch?v=abcDEF123_4',
      contentKey: 'yt:abcdef123_4',
      videoId: 'abcDEF123_4',
    });
  });

  it('accepts non-YouTube public pages for yt-dlp extraction', () => {
    const normalized = normalizeVideoArchiveInput('https://example.com/watch/video?id=1#frag');
    expect(normalized.url).toBe('https://example.com/watch/video?id=1');
    expect(normalized.contentKey).toMatch(/^video:[0-9a-f]{64}$/);
    expect(normalized.videoId).toBeUndefined();
  });

  it('rejects unsafe URLs', () => {
    expect(() => normalizeVideoArchiveInput('http://localhost/video')).toThrow(/unsafe url/i);
  });
});

describe('VIDEO_ARCHIVE_COST_SATS', () => {
  it('locks the hosted checkout price', () => {
    expect(VIDEO_ARCHIVE_COST_SATS).toBe(150_000);
  });
});
