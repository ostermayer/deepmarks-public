import { describe, expect, it } from 'vitest';
import { extractHttpUrls, socialLinkBookmarksFromNote } from './social-links.js';
import { KIND } from './kinds.js';
import type { SignedEventLike } from './bookmarks.js';

function note(content: string, overrides: Partial<SignedEventLike> = {}): SignedEventLike {
  return {
    id: 'a'.repeat(64),
    kind: KIND.note,
    pubkey: 'b'.repeat(64),
    created_at: 1_700_000_000,
    tags: [],
    content,
    ...overrides,
  };
}

describe('social note link extraction', () => {
  it('extracts only clean http links from note text', () => {
    expect(extractHttpUrls(
      'Read this https://example.com/path?q=1, and skip nostr:abc plus https://example.com/path?q=1.',
    )).toEqual(['https://example.com/path?q=1']);
  });

  it('maps a note to link rows without rendering social note text', () => {
    const rows = socialLinkBookmarksFromNote(note(
      'Long Nostr commentary around https://example.com/paper.pdf that Deepmarks should not render.',
    ));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      url: 'https://example.com/paper.pdf',
      title: 'pdf from example.com',
      description: '',
      tags: [],
      savedAt: 1_700_000_000,
      source: 'nostr-note-link',
      sourceEventId: 'a'.repeat(64),
      sourceContent: 'Long Nostr commentary around https://example.com/paper.pdf that Deepmarks should not render.',
    }));
  });

  it('uses readable fallback titles for direct media links', () => {
    const rows = socialLinkBookmarksFromNote(note(
      'image https://blossom.band/39762c9d7daf4834268382a180001ceaf67ff03d2ae4e28aa63619c50c2c7ad6.jpg and video https://blossom.primal.net/5605dcac7b8fde7e003959fb221791f6dff0dc424e581894d6c4443a8f18b502.mp4',
    ));

    expect(rows.map((row) => row.title)).toEqual([
      'image from blossom.band',
      'video from blossom.primal.net',
    ]);
  });

  it('uses NIP-92 imeta thumbnails for direct video posts', () => {
    const videoUrl = 'https://r2.primal.net/cache/0/7a/5d/07a5d354f1b2afb22f0ab0af038f7edb87dd6855a1cabee1178d63a97abd7cdc.mov';
    const thumbUrl = 'https://image.primal.net/thumbnail/07a5d354f1b2afb22f0ab0af038f7edb87dd6855a1cabee1178d63a97abd7cdc.jpg';
    const rows = socialLinkBookmarksFromNote(note(videoUrl, {
      tags: [[
        'imeta',
        `url ${videoUrl}`,
        'm video/quicktime',
        `thumb ${thumbUrl}`,
      ]],
    }));

    expect(rows[0]).toEqual(expect.objectContaining({
      sourceMediaMime: 'video/quicktime',
      sourceMediaThumbnail: thumbUrl,
    }));
  });

  it('ignores non-kind-1 events', () => {
    expect(socialLinkBookmarksFromNote(note('https://example.com', { kind: KIND.webBookmark }))).toEqual([]);
  });
});
