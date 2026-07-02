import { describe, expect, it } from 'vitest';
import { isYoutubeAuthGate } from '@src/youtube.js';

describe('isYoutubeAuthGate', () => {
  it('matches the YouTube sign-in / bot-challenge errors that justify a cookie retry', () => {
    const gates = [
      'yt-dlp exited 1: ERROR: [youtube] cIZpaWpI-NQ: Sign in to confirm you’re not a bot. Use --cookies',
      "ERROR: [youtube] X: Sign in to confirm you're not a bot.",
      'ERROR: [youtube] X: This video may be inappropriate for some users.',
      'ERROR: [youtube] X: Sign in to confirm your age',
      'ERROR: account authentication is required',
    ];
    for (const msg of gates) {
      expect(isYoutubeAuthGate(new Error(msg))).toBe(true);
      expect(isYoutubeAuthGate(msg)).toBe(true); // also accepts a bare string
    }
  });

  it('does NOT treat ordinary / transient failures as an auth gate (no needless cookie retry)', () => {
    const notGates = [
      'yt-dlp exited 1: ERROR: [youtube] X: Video unavailable',
      'yt-dlp exited 1: ERROR: [youtube] X: Private video',
      'yt-dlp exited 1: ERROR: Unsupported URL',
      'yt-dlp timed out after 60000ms',
      'ECONNRESET',
      'mp4-compatible media download failed',
      '',
    ];
    for (const msg of notGates) {
      expect(isYoutubeAuthGate(new Error(msg))).toBe(false);
    }
  });
});
