import { describe, expect, it } from 'vitest';
import {
  buildBookmarkCleanupAudit,
  canonicalCleanupUrl,
} from '$lib/bookmark-cleanup.js';
import type { ParsedBookmark } from '$lib/nostr/bookmarks.js';

function bookmark(url: string, savedAt: number, extra: Partial<ParsedBookmark> = {}): ParsedBookmark {
  return {
    url,
    title: extra.title ?? url,
    description: '',
    tags: [],
    archivedForever: false,
    savedAt,
    curator: 'a'.repeat(64),
    eventId: `event-${savedAt}`,
    ...extra,
  };
}

describe('canonicalCleanupUrl', () => {
  it('normalizes tracking noise without changing the destination path', () => {
    expect(canonicalCleanupUrl('HTTPS://Example.COM:443/path/?b=2&utm_source=x&a=1#frag'))
      .toBe('https://example.com/path?a=1&b=2');
  });
});

describe('buildBookmarkCleanupAudit', () => {
  it('selects redundant canonical duplicates while keeping the newest copy', () => {
    const older = bookmark('https://example.com/page?utm_source=newsletter', 10);
    const newer = bookmark('https://example.com/page', 20);

    const audit = buildBookmarkCleanupAudit({ bookmarks: [older, newer] });

    expect(audit.duplicateGroups).toBe(1);
    expect(audit.recommendedDeletes).toBe(1);
    expect(audit.candidates).toHaveLength(1);
    expect(audit.candidates[0]?.bookmark.url).toBe(older.url);
    expect(audit.candidates[0]?.reasons).toContain('duplicate-canonical-url');
  });

  it('surfaces failed archive queue entries as recommended cleanup', () => {
    const failed = bookmark('https://dead.example/imported', 30);

    const audit = buildBookmarkCleanupAudit({
      bookmarks: [failed],
      failedArchiveUrls: new Set([failed.url]),
    });

    expect(audit.failedArchives).toBe(1);
    expect(audit.recommendedDeletes).toBe(1);
    expect(audit.candidates[0]?.reasons).toContain('archive-failed');
  });

  it('counts missing archives separately without adding cleanup candidates', () => {
    const missing = bookmark('https://example.com/no-archive', 40);

    const audit = buildBookmarkCleanupAudit({
      bookmarks: [missing],
      archiveByDefault: true,
      archivedUrlKeys: new Set(),
      queuedArchiveUrls: new Set(),
    });

    expect(audit.missingArchives).toBe(1);
    expect(audit.missingArchiveBookmarks.map((item) => item.url)).toEqual([missing.url]);
    expect(audit.recommendedDeletes).toBe(0);
    expect(audit.candidates).toHaveLength(0);
  });

  it('does not queue missing archives for bookmarks already marked as duplicate cleanup', () => {
    const older = bookmark('https://example.com/page?utm_source=newsletter', 10);
    const newer = bookmark('https://example.com/page', 20);

    const audit = buildBookmarkCleanupAudit({
      bookmarks: [older, newer],
      archiveByDefault: true,
      archivedUrlKeys: new Set(),
      queuedArchiveUrls: new Set(),
    });

    expect(audit.candidates.map((candidate) => candidate.bookmark.url)).toEqual([older.url]);
    expect(audit.missingArchiveBookmarks.map((item) => item.url)).toEqual([newer.url]);
  });
});
