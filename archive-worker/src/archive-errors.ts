// Centralized error classification for the archive worker.
//
// The retryable-vs-permanent decision drives retries, refunds, and the
// rescue pass, and the audit kept finding subtle classification bugs. Keeping
// these together — and unit-tested — makes that decision auditable in one
// place instead of scattered through the ~2,000-line worker.
import { RenderError } from './renderer.js';

/**
 * A failure that will not change on retry — bad input, gone content, or a
 * policy rejection. Thrown by the capture paths; `categorize()` maps it to
 * 'permanent' so the job fails terminally (and is refunded / handed to rescue)
 * instead of burning retries.
 */
export class PermanentError extends Error {
  readonly category = 'permanent' as const;
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

/** Decide whether a thrown error should be retried or is terminal. */
export function categorize(err: unknown): 'retryable' | 'permanent' {
  if (err instanceof PermanentError) return 'permanent';
  if (err instanceof RenderError) return err.category;

  const msg = err instanceof Error ? err.message : String(err);
  if (isPermanentMediaDownloadError(msg)) return 'permanent';
  // Heuristics: network-ish errors are retryable.
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|503|502|504|fetch failed|timeout/i.test(msg)) {
    return 'retryable';
  }
  // Default: retryable. We'd rather spend one extra Playwright launch than
  // permanently fail a user's archive over an unknown error.
  return 'retryable';
}

/** yt-dlp failures that are genuinely terminal (gone / blocked content). */
export function isPermanentMediaDownloadError(message: string): boolean {
  return /yt-dlp exited \d+:/i.test(message) && (
    // Auth/bot walls stay PERMANENT on purpose: the within-attempt cookie
    // fallback already gets one shot, and an immediate 3× retry can't change
    // a wall in seconds. The client-side media-retry cooldown (~2 days)
    // re-requests these once the IP-reputation/cookie situation may differ.
    /sign in to confirm/i.test(message) ||
    /account authentication is required/i.test(message) ||
    /unsupported url/i.test(message) ||
    /video unavailable/i.test(message) ||
    /no longer available/i.test(message) ||
    /copyright claim/i.test(message) ||
    /private video/i.test(message) ||
    /unable to download api page: HTTP Error 404/i.test(message) ||
    /HTTP Error 404: Not Found/i.test(message)
  );
}
