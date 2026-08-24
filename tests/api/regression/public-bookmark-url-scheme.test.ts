// Regression: only /publish validated bookmark URL scheme. A kind:39701
// published directly to the relay (then mirrored by the fanout indexer)
// could carry a javascript:/data: d-tag, which the first-paint cache and
// Meili index would then serve — and a client renders the URL as an href.
// cachePublicBookmarkEvent and meiliBookmarkDoc now reject non-http(s).

import { describe, expect, it, vi } from 'vitest';
import type { Event as NostrEvent } from 'nostr-tools';

import { cachePublicBookmarkEvent } from '@src/public-bookmark-cache.js';
import { meiliBookmarkDoc } from '@src/routes/public-bookmarks.js';

function bookmarkEvent(url: string): NostrEvent {
  return {
    id: 'f'.repeat(64),
    pubkey: 'a'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 39701,
    tags: [['d', url], ['title', 'x']],
    content: '',
    sig: '0'.repeat(128),
  } as NostrEvent;
}

describe('public bookmark URL scheme guard', () => {
  it('cachePublicBookmarkEvent skips a javascript: d-tag without touching redis', async () => {
    const multi = vi.fn(() => { throw new Error('redis must not be written for a javascript: url'); });
    const redis = { multi } as never;
    await expect(cachePublicBookmarkEvent(redis, bookmarkEvent('javascript:alert(1)'))).resolves.toBeUndefined();
    expect(multi).not.toHaveBeenCalled();
  });

  it('cachePublicBookmarkEvent skips a data: d-tag', async () => {
    const multi = vi.fn(() => { throw new Error('redis must not be written for a data: url'); });
    const redis = { multi } as never;
    await cachePublicBookmarkEvent(redis, bookmarkEvent('data:text/html,<script>alert(1)</script>'));
    expect(multi).not.toHaveBeenCalled();
  });

  it('meiliBookmarkDoc returns null for a non-http(s) URL', async () => {
    const redis = { get: vi.fn(), scard: vi.fn() } as never;
    const doc = await meiliBookmarkDoc(bookmarkEvent('javascript:alert(1)'), { redis });
    expect(doc).toBeNull();
    expect((redis as unknown as { get: ReturnType<typeof vi.fn> }).get).not.toHaveBeenCalled();
  });

  it('meiliBookmarkDoc still indexes a normal http(s) URL', async () => {
    const redis = { get: vi.fn(async () => null), scard: vi.fn(async () => 0) } as never;
    const doc = await meiliBookmarkDoc(bookmarkEvent('https://example.com/post'), { redis });
    expect(doc).not.toBeNull();
    expect(doc?.url).toBe('https://example.com/post');
    expect(doc?.domain).toBe('example.com');
  });
});
