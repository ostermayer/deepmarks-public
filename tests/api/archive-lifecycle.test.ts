import { describe, expect, it } from 'vitest';
import {
  archiveFilesForRecord,
  archiveRecordTimelineAt,
  compareArchiveRecordsNewest,
  deletePrimaryArchiveBlobs,
  parseArchiveRecord,
  type ArchiveRecord,
} from '@src/archive-lifecycle.js';
import type { BlossomBlobStore } from '@src/blossom-blob-store.js';

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

  it('normalizes multi-file scholarly archive records with the primary file first', () => {
    const htmlHash = 'a'.repeat(64);
    const pdfHash = 'b'.repeat(64);
    const rec = parseArchiveRecord(htmlHash, JSON.stringify({
      jobId: 'job-scholar',
      ownerPubkey: 'owner',
      url: 'https://journal.example/article',
      blobHash: htmlHash,
      tier: 'public',
      archivedAt: 1_700_000_000,
      files: [
        { role: 'html', blobHash: htmlHash, url: 'https://journal.example/article', contentType: 'text/html' },
        { role: 'pdf', blobHash: pdfHash, url: 'https://journal.example/article.pdf', contentType: 'application/pdf' },
      ],
    }), 'owner');

    expect(rec).not.toBeNull();
    expect(archiveFilesForRecord(rec!)).toEqual([
      { role: 'html', blobHash: htmlHash, url: 'https://journal.example/article', contentType: 'text/html', mirrors: undefined, source: undefined, fileName: undefined, thumbHash: undefined },
      { role: 'pdf', blobHash: pdfHash, url: 'https://journal.example/article.pdf', contentType: 'application/pdf', mirrors: undefined, source: undefined, fileName: undefined, thumbHash: undefined },
    ]);
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

describe('deletePrimaryArchiveBlobs', () => {
  it('passes archive file metadata to primary blob deletion', async () => {
    const htmlHash = 'a'.repeat(64);
    const thumbHash = 'b'.repeat(64);
    const deleted: unknown[] = [];
    const blobStore = {
      delete: async (target: unknown) => {
        deleted.push(target);
      },
    } as unknown as BlossomBlobStore;

    await deletePrimaryArchiveBlobs(blobStore, {
      blobHash: htmlHash,
      url: 'https://example.com/article',
      source: 'render',
      contentType: 'text/html',
      fileName: 'article.html',
      thumbHash,
      mirrors: [],
      kind: 'webpage',
      files: [],
    });

    expect(deleted).toEqual([
      {
        blobHash: htmlHash,
        contentType: 'text/html',
        fileName: 'article.html',
        url: 'https://example.com/article',
      },
      {
        blobHash: thumbHash,
        contentType: 'image/jpeg',
      },
    ]);
  });
});
