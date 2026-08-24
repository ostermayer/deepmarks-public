import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import {
  PERMANENT_FAILURE_REENQUEUE_WINDOW_SECONDS,
  RETRYABLE_FAILURE_REENQUEUE_BASE_SECONDS,
  archiveFailureMessage,
  archiveFailureReenqueueWindowSeconds,
  classifyArchiveFailureReason,
  clearArchiveFailure,
  getArchiveFailure,
  getRecentArchiveFailure,
  hasRecentPermanentArchiveFailure,
  isPermanentArchiveFailureReason,
  isYoutubeBotWallError,
  parseArchiveFailureRecord,
  recordArchiveFailure,
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
    // Prod case: a tweet with no video. yt-dlp marks it retryable, but the
    // content genuinely isn't there — a permanent 'not-found', so the
    // permanent-failure gate stops backfills from re-enqueueing it forever
    // (it used to classify 'timeout' and loop). Never an operator email.
    const error = 'yt-dlp exited 1: ERROR: [twitter] 17139: No video could be found in this tweet';
    const reason = classifyArchiveFailureReason(error, 'retryable');
    expect(reason).toBe('not-found');
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

  it('marks only content-gone reasons as permanent', () => {
    expect(isPermanentArchiveFailureReason('not-found')).toBe(true);
    expect(isPermanentArchiveFailureReason('too-large')).toBe(true);
    expect(isPermanentArchiveFailureReason('site-blocked')).toBe(false);
    expect(isPermanentArchiveFailureReason('timeout')).toBe(false);
    expect(isPermanentArchiveFailureReason('failed')).toBe(false);
  });

  it('gates automated re-enqueue on a recent permanent failure only', async () => {
    const owner = 'a'.repeat(64);
    const url = 'https://twitter.com/x/status/123';
    const now = 1_783_300_000;
    const record = (overrides: Record<string, unknown>) => JSON.stringify({
      jobId: 'lifetime:abc',
      ownerPubkey: owner,
      url,
      reason: 'not-found',
      failedAt: now - 3600,
      ...overrides,
    });
    const redisWith = (value: string | null) =>
      ({ hget: async () => value }) as unknown as Redis;

    // Fresh permanent failure → gate closed.
    expect(await hasRecentPermanentArchiveFailure(redisWith(record({})), owner, url, now)).toBe(true);
    // Same failure past the 30-day window → gate reopens (one quiet
    // re-check a month, in case the page came back).
    expect(await hasRecentPermanentArchiveFailure(
      redisWith(record({ failedAt: now - 31 * 24 * 3600 })), owner, url, now,
    )).toBe(false);
    // Transient reasons never gate.
    expect(await hasRecentPermanentArchiveFailure(
      redisWith(record({ reason: 'timeout' })), owner, url, now,
    )).toBe(false);
    // No record → no gate.
    expect(await hasRecentPermanentArchiveFailure(redisWith(null), owner, url, now)).toBe(false);
  });
});

describe('escalating terminal-failure re-enqueue gate', () => {
  const HOUR = 3600;

  it('scales the retryable cooldown with consecutive failures, capped at the permanent window', () => {
    expect(archiveFailureReenqueueWindowSeconds({ reason: 'timeout' }))
      .toBe(RETRYABLE_FAILURE_REENQUEUE_BASE_SECONDS);
    expect(archiveFailureReenqueueWindowSeconds({ reason: 'timeout', consecutiveFailures: 1 }))
      .toBe(6 * HOUR);
    expect(archiveFailureReenqueueWindowSeconds({ reason: 'failed', consecutiveFailures: 2 }))
      .toBe(12 * HOUR);
    expect(archiveFailureReenqueueWindowSeconds({ reason: 'site-blocked', consecutiveFailures: 3 }))
      .toBe(24 * HOUR);
    // The 2026-08-21 loop reached 92 consecutive failures on one URL —
    // deep strike counts converge on the permanent window, not overflow.
    expect(archiveFailureReenqueueWindowSeconds({ reason: 'timeout', consecutiveFailures: 92 }))
      .toBe(PERMANENT_FAILURE_REENQUEUE_WINDOW_SECONDS);
    // Permanent reasons keep the flat 30-day window regardless of strikes.
    expect(archiveFailureReenqueueWindowSeconds({ reason: 'not-found' }))
      .toBe(PERMANENT_FAILURE_REENQUEUE_WINDOW_SECONDS);
    expect(archiveFailureReenqueueWindowSeconds({ reason: 'too-large', consecutiveFailures: 1 }))
      .toBe(PERMANENT_FAILURE_REENQUEUE_WINDOW_SECONDS);
  });

  it('gates automated re-enqueue on ANY recent terminal failure, with escalation', async () => {
    const owner = 'a'.repeat(64);
    const url = 'http://www.washingtonpost.com/ac2/wp-dyn?contentId=A18077-2002Apr19';
    const now = 1_783_300_000;
    const record = (overrides: Record<string, unknown>) => JSON.stringify({
      jobId: 'lifetime:abc',
      ownerPubkey: owner,
      url,
      reason: 'timeout',
      failedAt: now - HOUR,
      ...overrides,
    });
    const redisWith = (value: string | null) =>
      ({ hget: async () => value }) as unknown as Redis;

    // Fresh retryable failure → gate closed (this is what the permanent-only
    // gate missed on 2026-08-21).
    expect(await getRecentArchiveFailure(redisWith(record({})), owner, url, now)).not.toBeNull();
    // First failure past the 6h base cooldown → one retry allowed.
    expect(await getRecentArchiveFailure(
      redisWith(record({ failedAt: now - 7 * HOUR })), owner, url, now,
    )).toBeNull();
    // Three consecutive failures widen the window to 24h.
    expect(await getRecentArchiveFailure(
      redisWith(record({ failedAt: now - 20 * HOUR, consecutiveFailures: 3 })), owner, url, now,
    )).not.toBeNull();
    expect(await getRecentArchiveFailure(
      redisWith(record({ failedAt: now - 25 * HOUR, consecutiveFailures: 3 })), owner, url, now,
    )).toBeNull();
    // Permanent reasons keep the 30-day window.
    expect(await getRecentArchiveFailure(
      redisWith(record({ reason: 'not-found', failedAt: now - 29 * 24 * HOUR })), owner, url, now,
    )).not.toBeNull();
    expect(await getRecentArchiveFailure(
      redisWith(record({ reason: 'not-found', failedAt: now - 31 * 24 * HOUR })), owner, url, now,
    )).toBeNull();
    // No record → retry allowed.
    expect(await getRecentArchiveFailure(redisWith(null), owner, url, now)).toBeNull();
  });

  it('increments consecutiveFailures on each recorded failure for the same owner+URL', async () => {
    const owner = 'a'.repeat(64);
    const url = 'https://example.com/flaky';
    const store = new Map<string, string>();
    const kv = new Map<string, string>();
    const redis = {
      hget: async (key: string, field: string) => store.get(`${key}\n${field}`) ?? null,
      hset: async (key: string, field: string, value: string) => {
        store.set(`${key}\n${field}`, value);
        return 1;
      },
      hdel: async (key: string, field: string) => {
        store.delete(`${key}\n${field}`);
        return 1;
      },
      get: async (key: string) => kv.get(key) ?? null,
      set: async (key: string, value: string) => {
        kv.set(key, value);
        return 'OK';
      },
    } as unknown as Redis;

    const base = {
      jobId: 'lifetime:one',
      ownerPubkey: owner,
      url,
      errorCategory: 'retryable',
      error: 'page.goto: net::ERR_HTTP2_PROTOCOL_ERROR',
      failedAt: 1_783_300_000,
    };
    await recordArchiveFailure(redis, base);
    expect((await getArchiveFailure(redis, owner, url))?.consecutiveFailures).toBe(1);

    await recordArchiveFailure(redis, { ...base, jobId: 'lifetime:two', failedAt: 1_783_303_600 });
    expect((await getArchiveFailure(redis, owner, url))?.consecutiveFailures).toBe(2);

    // A different URL for the same owner starts its own count.
    await recordArchiveFailure(redis, { ...base, url: 'https://example.com/other' });
    expect((await getArchiveFailure(redis, owner, 'https://example.com/other'))?.consecutiveFailures).toBe(1);
  });
});

describe('clear-tombstone vs in-flight failure write (2026-08-23 review)', () => {
  const owner = 'b'.repeat(64);
  const url = 'https://example.com/raced';

  function fakeRedis() {
    const store = new Map<string, string>();
    const kv = new Map<string, string>();
    return {
      hget: async (key: string, field: string) => store.get(`${key}\n${field}`) ?? null,
      hset: async (key: string, field: string, value: string) => { store.set(`${key}\n${field}`, value); return 1; },
      hdel: async (key: string, field: string) => { store.delete(`${key}\n${field}`); return 1; },
      get: async (key: string) => kv.get(key) ?? null,
      set: async (key: string, value: string) => { kv.set(key, value); return 'OK'; },
    } as unknown as Redis;
  }

  it('a failure that predates a concurrent success-clear does not resurrect the record', async () => {
    const redis = fakeRedis();
    const clearedAt = Math.floor(Date.now() / 1000);
    await clearArchiveFailure(redis, owner, url);
    await recordArchiveFailure(redis, {
      jobId: 'lifetime:stale', ownerPubkey: owner, url,
      errorCategory: 'retryable', error: 'timeout', failedAt: clearedAt - 30,
    });
    expect(await getArchiveFailure(redis, owner, url)).toBeNull();
  });

  it('a genuinely NEWER failure still writes after a clear', async () => {
    const redis = fakeRedis();
    await clearArchiveFailure(redis, owner, url);
    await recordArchiveFailure(redis, {
      jobId: 'lifetime:fresh', ownerPubkey: owner, url,
      errorCategory: 'retryable', error: 'timeout',
      failedAt: Math.floor(Date.now() / 1000) + 5,
    });
    expect((await getArchiveFailure(redis, owner, url))?.jobId).toBe('lifetime:fresh');
  });
});
