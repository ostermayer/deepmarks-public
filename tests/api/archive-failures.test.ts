import { describe, expect, it } from 'vitest';
import {
  archiveFailureMessage,
  classifyArchiveFailureReason,
  parseArchiveFailureRecord,
  shouldAlertArchiveFailure,
} from '../../api/src/archive-failures.js';

describe('archive failure records', () => {
  it('classifies blocked-site archive failures from HTTP 403 style errors', () => {
    const reason = classifyArchiveFailureReason('page returned HTTP 403', 'permanent');

    expect(reason).toBe('site-blocked');
    expect(archiveFailureMessage(reason)).toBe('Site blocked the archive capture.');
    expect(shouldAlertArchiveFailure(reason, 'page returned HTTP 403')).toBe(false);
  });

  it('does not alert operators for remote page HTTP errors', () => {
    expect(shouldAlertArchiveFailure('failed', 'page returned HTTP 429')).toBe(false);
    expect(shouldAlertArchiveFailure('failed', 'renderer crashed')).toBe(true);
  });

  it('does not alert operators for archive output that exceeds the size limit', () => {
    const reason = classifyArchiveFailureReason('SingleFile output 253358251 bytes exceeds 157286400', 'permanent');

    expect(reason).toBe('too-large');
    expect(archiveFailureMessage(reason)).toBe('Page was too large for the archive size limit.');
    expect(shouldAlertArchiveFailure(reason, 'SingleFile output 253358251 bytes exceeds 157286400')).toBe(false);
  });

  it('does not alert operators for one-off remote page load timeouts', () => {
    expect(shouldAlertArchiveFailure(
      'timeout',
      'page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "https://www.cnn.com/", waiting until "load"',
    )).toBe(false);
    expect(shouldAlertArchiveFailure('timeout', 'render exceeded total timeout')).toBe(false);
  });

  it('does not alert operators for remote page TLS/network failures', () => {
    const error = 'page.goto: net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH at https://gomix.com/community/community-picks';
    const reason = classifyArchiveFailureReason(error, 'retryable');

    expect(reason).toBe('site-blocked');
    expect(shouldAlertArchiveFailure(reason, error)).toBe(false);
  });

  it('does not alert operators for direct-file (PDF/media) source fetch timeouts', () => {
    // Real MAX_ATTEMPTS alerts seen in the wild: a state-gov PDF and an
    // academic PDF on slow/dead hosts. These are source-side fetch()
    // failures, not operator incidents — the rescue pass recovers any that
    // have a Wayback snapshot.
    for (const error of [
      'fetch failed',
      'The operation was aborted due to timeout',
      'connect ETIMEDOUT 1.2.3.4:443',
      'getaddrinfo ENOTFOUND www2.ims.nus.edu.sg',
      'UND_ERR_CONNECT_TIMEOUT',
    ]) {
      const reason = classifyArchiveFailureReason(error, 'retryable');
      expect(shouldAlertArchiveFailure(reason, error)).toBe(false);
    }
    // A genuine worker/renderer crash still pages.
    expect(shouldAlertArchiveFailure('failed', 'renderer crashed')).toBe(true);
  });

  it('does not alert operators for stale jobs marked lost by archive audit', () => {
    expect(shouldAlertArchiveFailure('failed', 'archive job lost before completion — please retry')).toBe(false);
  });

  it('does not alert operators for best-effort media archive failures', () => {
    // Prod case: a tweet with no video. yt-dlp marks it retryable, so it
    // classifies as 'timeout', but a media job with no media is an
    // expected content outcome — not an operator email.
    const error = 'yt-dlp exited 1: ERROR: [twitter] 17139: No video could be found in this tweet';
    const reason = classifyArchiveFailureReason(error, 'retryable');
    expect(reason).toBe('timeout');
    expect(shouldAlertArchiveFailure(reason, error, 'media')).toBe(false); // suppressed by kind
    expect(shouldAlertArchiveFailure(reason, error)).toBe(false);          // suppressed by yt-dlp text
    expect(shouldAlertArchiveFailure('failed', 'Unsupported URL', 'video')).toBe(false);
    // A non-media systemic failure still pages the operator.
    expect(shouldAlertArchiveFailure('failed', 'renderer crashed', 'webpage')).toBe(true);
  });

  it('parses only failures owned by the expected pubkey', () => {
    const ownerPubkey = 'a'.repeat(64);
    const raw = JSON.stringify({
      jobId: 'lifetime:abc',
      ownerPubkey,
      url: 'https://archiveofourown.org/works/83355841',
      reason: 'site-blocked',
      message: 'Site blocked the archive capture.',
      error: 'page returned HTTP 403',
      failedAt: 1_700_000_000,
    });

    expect(parseArchiveFailureRecord(raw, ownerPubkey)?.reason).toBe('site-blocked');
    expect(parseArchiveFailureRecord(raw, 'b'.repeat(64))).toBeNull();
  });
});
