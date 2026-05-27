import { describe, expect, it } from 'vitest';
import {
  archiveRecordTimelineAt,
  compareArchiveRecordsNewest,
  parseArchiveRecord,
  type ArchiveRecord,
} from './archive-lifecycle.js';

function archive(overrides: Partial<ArchiveRecord>): ArchiveRecord {
  return {
    jobId: overrides.jobId ?? 'job',
    ownerPubkey: overrides.ownerPubkey ?? 'owner',
    url: overrides.url ?? 'https://example.com',
    blobHash: overrides.blobHash ?? 'blob',
    tier: overrides.tier ?? 'public',
    archivedAt: overrides.archivedAt ?? 0,
    ...overrides,
  };
}

describe('archive timeline timestamps', () => {
  it('parses completion time separately from the bookmark timeline timestamp', () => {
    const rec = parseArchiveRecord('fallback-blob', JSON.stringify({
      jobId: 'job-1',
      ownerPubkey: 'owner',
      url: 'https://example.com',
      blobHash: 'blob-1',
      tier: 'private',
      archivedAt: 1_700_000_000,
      completedAt: 1_700_086_400,
      bookmarkSavedAt: 1_700_000_000,
    }), 'owner');

    expect(rec).toMatchObject({
      archivedAt: 1_700_000_000,
      completedAt: 1_700_086_400,
      bookmarkSavedAt: 1_700_000_000,
    });
  });

  it('preserves direct-file archive metadata for clients', () => {
    const rec = parseArchiveRecord('fallback-blob', JSON.stringify({
      jobId: 'job-pdf',
      ownerPubkey: 'owner',
      url: 'https://example.com/report.pdf',
      blobHash: 'blob-pdf',
      tier: 'public',
      archivedAt: 1_700_000_000,
      kind: 'file',
      contentType: 'application/pdf',
      fileName: 'report.pdf',
    }), 'owner');

    expect(rec).toMatchObject({
      kind: 'file',
      contentType: 'application/pdf',
      fileName: 'report.pdf',
    });
  });

  it('uses bookmarkSavedAt as the archive-list timeline when present', () => {
    expect(archiveRecordTimelineAt(archive({
      archivedAt: 1_800_000_000,
      bookmarkSavedAt: 1_700_000_000,
    }))).toBe(1_700_000_000);
  });

  it('sorts archives by bookmark time, then completion time for ties', () => {
    const olderBookmarkLaterArchive = archive({
      jobId: 'older-bookmark-later-archive',
      blobHash: 'b',
      archivedAt: 1_700_000_000,
      completedAt: 1_900_000_000,
      bookmarkSavedAt: 1_700_000_000,
    });
    const newerBookmarkEarlierArchive = archive({
      jobId: 'newer-bookmark-earlier-archive',
      blobHash: 'a',
      archivedAt: 1_800_000_000,
      completedAt: 1_800_000_100,
      bookmarkSavedAt: 1_800_000_000,
    });
    const sameBookmarkLaterArchive = archive({
      jobId: 'same-bookmark-later-archive',
      blobHash: 'c',
      archivedAt: 1_700_000_000,
      completedAt: 1_900_000_001,
      bookmarkSavedAt: 1_700_000_000,
    });

    expect([
      olderBookmarkLaterArchive,
      newerBookmarkEarlierArchive,
      sameBookmarkLaterArchive,
    ].sort(compareArchiveRecordsNewest).map((rec) => rec.jobId)).toEqual([
      'newer-bookmark-earlier-archive',
      'same-bookmark-later-archive',
      'older-bookmark-later-archive',
    ]);
  });
});
