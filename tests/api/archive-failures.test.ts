import { describe, expect, it } from 'vitest';
import {
  archiveFailureMessage,
  classifyArchiveFailureReason,
  isYoutubeBotWallError,
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

  it('classifies a host-agnostic bot-challenge interstitial as site-blocked', () => {
    // Prod case (Kaggle, 2026-06-30): the renderer throws RenderError(
    // 'anti_bot_wall', 'bot-challenge interstitial on www.kaggle.com',
    // 'retryable'). It used to fall through to 'timeout', so the owner's card
    // read "archive failed / Archive timed out" — misleading for a bot-wall.
    // As site-blocked the card reads "site blocked" and it stops paging.
    const error = 'bot-challenge interstitial on www.kaggle.com';
    const reason = classifyArchiveFailureReason(error, 'retryable');
    expect(reason).toBe('site-blocked');
    expect(archiveFailureMessage(reason)).toBe('Site blocked the archive capture.');
    expect(shouldAlertArchiveFailure(reason, error, 'webpage', 'https://www.kaggle.com/x')).toBe(false);
    // Guard: match only the generic interstitial, NOT the YouTube webpage wall
    // string, which a separate test pins to 'failed'.
    expect(classifyArchiveFailureReason('YouTube anti-bot sign-in wall', 'permanent')).toBe('failed');
  });

  it('does not alert operators for remote page HTTP errors', () => {
    expect(shouldAlertArchiveFailure('failed', 'page returned HTTP 429')).toBe(false);
    expect(shouldAlertArchiveFailure('failed', 'renderer crashed')).toBe(true);
  });

  it('classifies a deleted tweet as not-found (permanent, non-alerting)', () => {
    // A deleted tweet 404s on every FixTweet provider. The worker now throws
    // PermanentError('tweet_deleted', 'tweet not found — deleted or
    // unavailable: <url>') instead of a retryable RenderError, so it fails on
    // the first attempt and reads "not found" instead of the old, misleading
    // "timeout" (retryable -> timeout) that also paged the operator.
    const error = 'tweet not found — deleted or unavailable: https://twitter.com/ostermayer/status/78428980658700288';
    const reason = classifyArchiveFailureReason(error, 'permanent');
    expect(reason).toBe('not-found');
    expect(archiveFailureMessage(reason)).toBe('Page was not found when Deepmarks tried to archive it.');
    expect(shouldAlertArchiveFailure(reason, error, 'webpage')).toBe(false);
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

  it('does not alert operators for the YouTube webpage bot-wall (source-side, no cookies)', () => {
    // Prod case: lifetime webpage archive of a YouTube URL — Playwright hits
    // Google's "Sign in to confirm you're not a bot" wall and the renderer
    // throws RenderError('anti_bot_wall', 'YouTube anti-bot sign-in wall').
    // This is a source-side outcome (Google blocks headless capture), not an
    // operator incident. The worker now builds an oEmbed stub first; this
    // only fires when oEmbed also fails. Either way, no page.
    const error = 'YouTube anti-bot sign-in wall';
    const url = 'https://m.youtube.com/watch?v=U9cazC7DBFk';
    const reason = classifyArchiveFailureReason(error, 'permanent');
    expect(reason).toBe('failed');
    expect(shouldAlertArchiveFailure(reason, error, 'webpage', url)).toBe(false);
    // The yt-dlp cookie-refresh matcher must NOT match the webpage-path
    // string — the webpage path uses no cookies, so a cookie-refresh alert
    // there would be a false pager. Only the media-path yt-dlp text matches.
    expect(isYoutubeBotWallError(error, url)).toBe(false);
  });

  it('still pages the operator for the yt-dlp media-path cookie-expiry wall', () => {
    // The media add-on (kind:'media', yt-dlp) is suppressed by the kind
    // gate in shouldAlertArchiveFailure, but the route fires a distinct
    // rate-limited cookie-refresh alert via isYoutubeBotWallError. That
    // matcher must still recognize the yt-dlp text.
    const error = "yt-dlp: Sign in to confirm you're not a bot. Use --cookies";
    const url = 'https://www.youtube.com/watch?v=U9cazC7DBFk';
    expect(isYoutubeBotWallError(error, url)).toBe(true);
  });

  it('does NOT page for unfixable YouTube failures that merely carry the --cookies hint', () => {
    // Regression (2026-06-29): yt-dlp appends "Use --cookies-from-browser or
    // --cookies for the authentication" to private/removed/members/age-gated
    // errors, and "Sign in to confirm your age" to age gates. The old matcher
    // keyed on bare "use --cookies" / "sign in to confirm" and paged the
    // operator to re-export cookies for videos no cookie can recover — the
    // real failures were copyright takedowns, terminated channels, and one
    // genuinely private video. None are cookie-expiry.
    const url = 'https://www.youtube.com/watch?v=3VwUSOrNSEA';
    for (const error of [
      // The exact prod alert example (job media:e7b507a2…).
      "yt-dlp exited 1: ERROR: [youtube] 3VwUSOrNSEA: Private video. Sign in if you've been granted access to this video. Use --cookies-from-browser or --cookies for the authentication.",
      'yt-dlp exited 1: ERROR: [youtube] sgGNBue6gXg: Video unavailable. It was removed following a copyright removal request by a third party',
      'yt-dlp exited 1: ERROR: [youtube] -iYg4K9O9jk: Video unavailable. This video is no longer available because the YouTube account associated with this video has been terminated.',
      'yt-dlp exited 1: ERROR: [youtube] abc12345678: Sign in to confirm your age. This video may be inappropriate for some users. Use --cookies for the authentication.',
    ]) {
      expect(isYoutubeBotWallError(error, url)).toBe(false);
    }
  });

  it('still pages for genuine cookie-expiry / rotated-cookie errors', () => {
    const url = 'https://www.youtube.com/watch?v=U9cazC7DBFk';
    // yt-dlp's real message when the session cookies have been rotated out —
    // the old `expired|invalid` clause actually missed this wording.
    expect(isYoutubeBotWallError(
      'yt-dlp exited 1: ERROR: [youtube] The provided YouTube account cookies are no longer valid, they have probably been rotated.',
      url,
    )).toBe(true);
    expect(isYoutubeBotWallError('ERROR: [youtube] abc: cookies expired — please re-export', url)).toBe(true);
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
