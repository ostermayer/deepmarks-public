import { describe, expect, it } from 'vitest';

import { isPotentialMediaUrl, mediaArchiveCounts } from '$lib/media-archive.js';
import type { ArchiveRecord } from '$lib/api/client';
import type { ParsedBookmark } from '$lib/nostr/bookmarks';

function bookmark(url: string): ParsedBookmark {
  return {
    url,
    title: url,
    description: '',
    tags: [],
    archivedForever: false,
    savedAt: 1_700_000_000,
    curator: 'pub',
    eventId: 'event',
  };
}

describe('media archive tracking', () => {
  it('matches YouTube short links to canonical archived media URLs', () => {
    const bookmarks = [
      bookmark('https://youtu.be/abcDEF123_4?t=10'),
    ];
    const archives: ArchiveRecord[] = [{
      jobId: 'media:1',
      url: 'https://www.youtube.com/watch?v=abcDEF123_4',
      blobHash: 'hash',
      tier: 'private',
      archivedAt: 1_700_000_001,
      kind: 'media',
    }];

    expect(mediaArchiveCounts(bookmarks, archives)).toEqual({
      eligible: 1,
      archived: 1,
      queued: 0,
    });
  });

  it('treats direct images, Reddit/X media pages, PeerTube hosts, and Blossom blobs as media candidates', () => {
    expect(isPotentialMediaUrl('https://cdn.example/photos/cat.webp')).toBe(true);
    expect(isPotentialMediaUrl('https://cdn.example/photos/live.heic')).toBe(true);
    expect(isPotentialMediaUrl('https://cdn.example/audio/book.m4b')).toBe(true);
    expect(isPotentialMediaUrl('https://cdn.example/video/master.m3u8')).toBe(true);
    expect(isPotentialMediaUrl('https://www.reddit.com/r/videos/comments/abc/example/')).toBe(true);
    expect(isPotentialMediaUrl('https://x.com/deepmarks/status/1234567890')).toBe(true);
    expect(isPotentialMediaUrl('https://tilvids.com/w/abc123')).toBe(true);
    expect(isPotentialMediaUrl('https://creator.example.video/videos/watch/3fbf1c27-2e3a-4d0d-9f6a-123456789abc')).toBe(true);
    expect(isPotentialMediaUrl(`https://blossom.example/${'a'.repeat(64)}`)).toBe(true);
    expect(isPotentialMediaUrl('https://example.simplecast.com/episodes/an-episode')).toBe(true);
  });

  it('only treats YouTube watch-like URLs as media candidates', () => {
    expect(isPotentialMediaUrl('https://www.youtube.com/watch?v=abcDEF123_4')).toBe(true);
    expect(isPotentialMediaUrl('https://youtube.com/shorts/abcDEF123_4')).toBe(true);
    expect(isPotentialMediaUrl('https://youtu.be/abcDEF123_4?t=10')).toBe(true);
    expect(isPotentialMediaUrl('https://www.youtube.com/results?search_query=ronaldinho')).toBe(false);
    expect(isPotentialMediaUrl('https://m.youtube.com/channel/UCD-QkofF-bFBAcI83U8ZZeg')).toBe(false);
    expect(isPotentialMediaUrl('https://www.youtube.com/das_captcha?next=http%3A//www.youtube.com/watch%3Fv%3DjngYTJ1pXqY')).toBe(false);
  });

  it('counts image archive records as media archives', () => {
    const bookmarks = [bookmark('https://cdn.example/photos/cat.jpg')];
    const archives: ArchiveRecord[] = [{
      jobId: 'media:img',
      url: 'https://cdn.example/photos/cat.jpg',
      blobHash: 'hash',
      tier: 'private',
      archivedAt: 1_700_000_001,
      kind: 'media',
      contentType: 'image/jpeg',
    }];

    expect(mediaArchiveCounts(bookmarks, archives)).toEqual({
      eligible: 1,
      archived: 1,
      queued: 0,
    });
  });
});
