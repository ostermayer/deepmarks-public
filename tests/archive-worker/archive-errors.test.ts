import { describe, expect, it } from 'vitest';
import { RenderError } from '@src/renderer.js';
import { PermanentError, categorize, isPermanentMediaDownloadError } from '@src/archive-errors.js';

describe('archive error classification', () => {
  it('maps PermanentError and RenderError to their category', () => {
    expect(categorize(new PermanentError('x', 'bad input'))).toBe('permanent');
    expect(categorize(new RenderError('http_error', 'page returned HTTP 404', 'permanent'))).toBe('permanent');
    expect(categorize(new RenderError('timeout', 'render exceeded total timeout', 'retryable'))).toBe('retryable');
  });

  it('treats source-network errors as retryable', () => {
    for (const msg of ['fetch failed', 'connect ECONNREFUSED 1.2.3.4', 'getaddrinfo ETIMEDOUT', 'page returned HTTP 503', 'operation timeout']) {
      expect(categorize(new Error(msg))).toBe('retryable');
    }
  });

  it('defaults unknown errors to retryable (don’t permanently fail on an unknown)', () => {
    expect(categorize(new Error('some unexpected internal error'))).toBe('retryable');
    expect(categorize('a raw string error')).toBe('retryable');
  });

  it('classifies genuinely-gone yt-dlp media failures as permanent', () => {
    for (const reason of [
      'Sign in to confirm you’re not a bot',
      'Private video',
      'Video unavailable',
      'This video is no longer available',
      'blocked it on copyright claim grounds',
      'Unsupported URL',
      'HTTP Error 404: Not Found',
    ]) {
      const msg = `yt-dlp exited 1: ERROR: [youtube] abc: ${reason}`;
      expect(isPermanentMediaDownloadError(msg)).toBe(true);
      expect(categorize(new Error(msg))).toBe('permanent');
    }
  });

  it('keeps transient yt-dlp failures retryable', () => {
    // A 5xx / rate-limit from yt-dlp is not a "gone" state — retry it.
    const msg = 'yt-dlp exited 1: ERROR: unable to download video data: HTTP Error 503';
    expect(isPermanentMediaDownloadError(msg)).toBe(false);
    expect(categorize(new Error(msg))).toBe('retryable');
  });
});
