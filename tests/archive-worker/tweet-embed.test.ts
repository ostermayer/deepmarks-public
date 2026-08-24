import { describe, expect, it, vi } from 'vitest';
import { parseTweetUrl, isTweetUrl, buildTweetArchiveHtml, resolveTweetVideoUrl } from '@src/tweet-embed.js';
import { PermanentError } from '@src/archive-errors.js';

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

function pngResponse(): Response {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
}

const fxPayload = {
  code: 200,
  message: 'OK',
  tweet: {
    url: 'https://x.com/alice/status/123456789012345',
    id: '123456789012345',
    text: 'hello world\nsecond line https://example.com',
    created_at: 'Wed Apr 22 22:18:03 +0000 2026',
    author: {
      name: 'Alice',
      screen_name: 'alice',
      avatar_url: 'https://pbs.twimg.com/profile_images/1/a.jpg',
      verification: 'blue',
    },
    media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/media/x.jpg', width: 100, height: 100 }] },
    likes: 5,
    retweets: 2,
    replies: 1,
    views: 99,
  },
};

describe('tweet-embed', () => {
  it('parses tweet URLs and rejects non-tweets', () => {
    expect(parseTweetUrl('https://x.com/alice/status/123456789012345')).toEqual({ screenName: 'alice', id: '123456789012345' });
    expect(parseTweetUrl('https://twitter.com/Bob/status/99999999999')).toEqual({ screenName: 'Bob', id: '99999999999' });
    expect(parseTweetUrl('https://x.com/i/web/status/123456789012345')?.id).toBe('123456789012345');
    expect(parseTweetUrl('https://x.com/alice')).toBeNull();
    expect(isTweetUrl('https://example.com/post')).toBe(false);
    // Nitter-family mirror hosts ARE routed through the FixTweet builder (rebuilt
    // by status id), so a Nitter/xcancel rescue or bookmark archives cleanly
    // instead of rendering a dead mirror page.
    expect(parseTweetUrl('https://xcancel.com/a/status/1234567')).toEqual({ screenName: 'a', id: '1234567' });
    expect(parseTweetUrl('https://nitter.net/howaboua/status/2047077497855213663'))
      .toEqual({ screenName: 'howaboua', id: '2047077497855213663' });
    expect(isTweetUrl('https://nitter.poast.org/x/status/123456')).toBe(true);
    // ...but an unrelated host is still rejected.
    expect(parseTweetUrl('https://example.com/a/status/1234567')).toBeNull();
  });

  it('builds a self-contained HTML archive from the FixTweet API', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://api.fxtwitter.com/')) return jsonResponse(fxPayload);
      if (url.startsWith('https://pbs.twimg.com/')) return pngResponse();
      return new Response('nope', { status: 404 });
    });
    const out = await buildTweetArchiveHtml('https://x.com/alice/status/123456789012345', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(out).not.toBeNull();
    const html = out!.html.toString('utf-8');
    expect(out!.provider).toBe('https://api.fxtwitter.com');
    expect(html).toContain('Alice');
    expect(html).toContain('@alice');
    expect(html).toContain('hello world');
    expect(html).toContain('<br>second line'); // newline -> <br>
    expect(html).toContain('href="https://example.com"'); // url linkified
    expect(html).toContain('data:image/png;base64,'); // avatar + media inlined, self-contained
    expect(html).toContain('https://x.com/alice/status/123456789012345'); // link back to original
  });

  it('falls back across providers then returns null when none serve it', async () => {
    const fetchMock = vi.fn(async () => new Response('fail', { status: 502 }));
    const out = await buildTweetArchiveHtml('https://x.com/alice/status/123456789012345', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(out).toBeNull();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2); // tried both providers
  });

  it('fails permanently (tweet deleted) when every provider returns 404', async () => {
    // A deleted tweet 404s on all providers — that is a terminal "gone"
    // outcome, not a retryable timeout, so buildTweetArchiveHtml throws a
    // PermanentError the worker maps to a first-attempt, non-alerting
    // "not found" failure instead of burning MAX_ATTEMPTS.
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ code: 404, message: 'NOT_FOUND', tweet: null }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      buildTweetArchiveHtml('https://x.com/alice/status/78428980658700288', {
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(PermanentError);
    // message carries "not found" so Box A classifies it as reason 'not-found'
    await expect(
      buildTweetArchiveHtml('https://x.com/alice/status/78428980658700288', {
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/not found/i);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2); // tried both providers first
  });

  it('fails permanently when the live provider 404s and the other is DNS-dead', async () => {
    // Prod regression (2026-07-05): api.fixupx.com fell out of DNS entirely
    // (NXDOMAIN). A dead provider says nothing about the tweet, so it must
    // not veto api.fxtwitter.com's definitive 404 — before this fix every
    // deleted tweet was misclassified as a retryable "timeout", burned
    // MAX_ATTEMPTS, and re-alerted the operator on every backfill cycle.
    const dnsError = new TypeError('fetch failed');
    (dnsError as Error & { cause?: unknown }).cause = Object.assign(
      new Error('getaddrinfo ENOTFOUND api.fixupx.com'),
      { code: 'ENOTFOUND' },
    );
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://api.fxtwitter.com/')) {
        return new Response(JSON.stringify({ code: 404, message: 'NOT_FOUND', tweet: null }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw dnsError;
    });
    await expect(
      buildTweetArchiveHtml('https://twitter.com/ostermayer/status/78428980658700288', {
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it('stays retryable (not "deleted") when NO provider hostname resolves', async () => {
    // All-providers-NXDOMAIN means the box's DNS (or the whole provider
    // ecosystem) is broken — there is no evidence the tweet is gone, so the
    // job must stay retryable rather than permanently failing as not-found.
    const dnsError = new TypeError('fetch failed');
    (dnsError as Error & { cause?: unknown }).cause = Object.assign(
      new Error('getaddrinfo ENOTFOUND'),
      { code: 'ENOTFOUND' },
    );
    const fetchMock = vi.fn(async () => {
      throw dnsError;
    });
    const out = await buildTweetArchiveHtml('https://x.com/alice/status/78428980658700288', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(out).toBeNull();
  });

  it('stays retryable (null, not PermanentError) when a provider fails transiently', async () => {
    // First provider 5xx (transient), second 404 — a transient failure means
    // we are NOT certain the tweet is gone, so it must stay retryable.
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response('boom', { status: 503 })
        : new Response(JSON.stringify({ code: 404, tweet: null }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
    });
    const out = await buildTweetArchiveHtml('https://x.com/alice/status/78428980658700288', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(out).toBeNull();
  });

  it('returns null for non-tweet URLs without fetching', async () => {
    const fetchMock = vi.fn();
    const out = await buildTweetArchiveHtml('https://example.com/post', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves a tweet video to the best <=720p mp4 variant (caps 1080p)', async () => {
    const v720 = 'https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/c.mp4?tag=21';
    const v1080 = 'https://video.twimg.com/amplify_video/1/vid/avc1/1920x1080/d.mp4?tag=21';
    const payload = {
      tweet: {
        text: 'a video',
        author: { name: 'A', screen_name: 'a' },
        media: {
          all: [
            {
              type: 'video',
              url: v1080, // FixTweet's default points at the 1080p rendition
              thumbnail_url: 'https://pbs.twimg.com/x.jpg',
              variants: [
                { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/x.m3u8' },
                { content_type: 'video/mp4', url: 'https://video.twimg.com/amplify_video/1/vid/avc1/640x360/a.mp4' },
                { content_type: 'video/mp4', url: v720 },
                { content_type: 'video/mp4', url: v1080 },
              ],
            },
          ],
        },
      },
    };
    const fetchMock = vi.fn(async () => jsonResponse(payload));
    const out = await resolveTweetVideoUrl('https://x.com/a/status/123456789012345', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(out).toBe(v720); // capped at 720p, not the 1080p default
  });

  it('returns null video for a photo-only or non-twimg tweet', async () => {
    const payload = {
      tweet: {
        text: 'pic',
        author: { name: 'A', screen_name: 'a' },
        media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/media/x.jpg' }] },
      },
    };
    const fetchMock = vi.fn(async () => jsonResponse(payload));
    const out = await resolveTweetVideoUrl('https://x.com/a/status/123456789012345', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(out).toBeNull();
  });
});
