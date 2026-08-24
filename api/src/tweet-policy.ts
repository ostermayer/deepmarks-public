// Tweet recognition / rebuild policy — the api-side copy.
//
// archive-worker carries a DELIBERATE duplicate of this policy
// (archive-worker/src/tweet-embed.ts): the two packages build in separate
// Docker contexts (`build: ../../api` vs `build: ../../archive-worker`), so
// they cannot share source without restructuring both images. The
// cross-package sync test (tests/archive-worker/tweet-policy-sync.test.ts)
// is what keeps the copies from drifting — one already went stale when
// api.fixupx.com fell out of DNS and only the worker copy was fixed.
//
// This module must stay dependency-free: the sync test imports it from the
// worker's test context, where api-only packages aren't installed.

/** FixTweet-compatible providers (same JSON shape). Tried in order. */
export const FIXTWEET_PROVIDERS = ['https://api.fxtwitter.com', 'https://api.fixupx.com'] as const;
/** FixTweet asks callers to identify themselves in the User-Agent. */
export const FIXTWEET_USER_AGENT = 'Deepmarks-Archive/1.0 (+https://deepmarks.org/bot)';

/** Hosts whose /<user>/status/<id> URLs are tweets rebuilt via FixTweet —
 *  x/twitter plus the named Nitter-family mirrors (matched by host only;
 *  the mirror itself is never fetched). */
export const TWITTER_FAMILY_HOSTS = new Set([
  'x.com', 'twitter.com', 'mobile.twitter.com', 'xcancel.com', 'nitter.net',
]);

export function isTwitterFamilyHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  return TWITTER_FAMILY_HOSTS.has(normalized) || /(^|\.)nitter\./i.test(normalized);
}

export function twitterStatusId(parsed: URL): string | null {
  const match = safeDecodePath(parsed.pathname).match(/\/status(?:es)?\/(\d{5,25})/i);
  return match ? match[1]! : null;
}

export function tweetScreenName(parsed: URL): string {
  const match = safeDecodePath(parsed.pathname).match(/^\/([A-Za-z0-9_]{1,15})\/status/i);
  return match?.[1] ?? 'i';
}

/** Canonical x.com URL for a tweet on any twitter-family host (incl. Nitter),
 *  or null if it isn't a tweet. x.com is the only host the worker's FixTweet
 *  rebuild path recognizes, so every tweet rescue points here. */
export function canonicalTweetUrl(parsed: URL): string | null {
  const id = twitterStatusId(parsed);
  if (!id) return null;
  return `https://x.com/${tweetScreenName(parsed)}/status/${id}`;
}

function safeDecodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}
