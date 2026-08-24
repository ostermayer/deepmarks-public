import { describe, expect, it } from 'vitest';
import { PROVIDERS, UA, parseTweetUrl, isTweetUrl } from '@src/tweet-embed.js';
import {
  FIXTWEET_PROVIDERS,
  FIXTWEET_USER_AGENT,
  canonicalTweetUrl,
  isTwitterFamilyHost,
  twitterStatusId,
} from '../../api/src/tweet-policy.js';

// Cross-package drift guard. The tweet recognition/rebuild policy exists
// TWICE on purpose — archive-worker/src/tweet-embed.ts (Box B rebuilds the
// tweet) and api/src/tweet-policy.ts (Box A's rescue pass verifies + points
// candidates at the canonical x.com URL). The two packages build in separate
// Docker contexts, so they can't share source; this test is the contract
// that keeps the copies in agreement. It exists because one copy DID go
// stale: api.fixupx.com fell out of DNS (2026-07-05) and only the worker
// learned to handle it.
describe('tweet policy stays in sync across api and archive-worker', () => {
  it('uses the same FixTweet providers, in the same order', () => {
    expect([...PROVIDERS]).toEqual([...FIXTWEET_PROVIDERS]);
  });

  it('uses the same FixTweet User-Agent', () => {
    expect(UA).toBe(FIXTWEET_USER_AGENT);
  });

  it('recognizes the same URLs as tweets and extracts the same status id', () => {
    const fixtures: Array<{ url: string; id: string | null }> = [
      { url: 'https://x.com/alice/status/123456789012345', id: '123456789012345' },
      { url: 'https://twitter.com/Bob/status/99999999999', id: '99999999999' },
      { url: 'https://www.twitter.com/Bob/status/99999999999', id: '99999999999' },
      { url: 'https://mobile.twitter.com/a/status/1234567', id: '1234567' },
      { url: 'https://x.com/i/web/status/123456789012345', id: '123456789012345' },
      { url: 'https://xcancel.com/a/status/1234567', id: '1234567' },
      { url: 'https://nitter.net/howaboua/status/2047077497855213663', id: '2047077497855213663' },
      { url: 'https://nitter.poast.org/x/status/123456', id: '123456' },
      // Non-tweets must be rejected by BOTH sides.
      { url: 'https://example.com/a/status/1234567', id: null },
      { url: 'https://x.com/alice', id: null },
      { url: 'https://youtube.com/watch?v=abc12345678', id: null },
    ];
    for (const { url, id } of fixtures) {
      const workerParts = parseTweetUrl(url);
      const parsed = new URL(url);
      const apiId = isTwitterFamilyHost(parsed.hostname) ? twitterStatusId(parsed) : null;
      expect(workerParts?.id ?? null, `worker id for ${url}`).toBe(id);
      expect(apiId, `api id for ${url}`).toBe(id);
    }
  });

  it("the api's canonical x.com URL is always recognized by the worker", () => {
    // The rescue pass enqueues canonicalTweetUrl() output as a worker job —
    // if the worker's parser ever rejects it, every tweet rescue dead-ends.
    const sources = [
      'https://twitter.com/ostermayer/status/78428980658700288',
      'https://nitter.net/howaboua/status/2047077497855213663',
      'https://xcancel.com/a/status/1234567',
      'https://x.com/i/web/status/123456789012345',
    ];
    for (const source of sources) {
      const canonical = canonicalTweetUrl(new URL(source));
      expect(canonical, `canonical for ${source}`).toBeTruthy();
      expect(isTweetUrl(canonical!), `worker accepts ${canonical}`).toBe(true);
      expect(parseTweetUrl(canonical!)?.id).toBe(twitterStatusId(new URL(source)));
    }
  });
});
