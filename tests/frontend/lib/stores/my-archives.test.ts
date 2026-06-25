import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { ArchiveFailureRecord, ArchiveRecord } from '$lib/api/client';

vi.mock('$app/environment', () => ({ browser: false }));

function archive(overrides: Partial<ArchiveRecord>): ArchiveRecord {
  return {
    jobId: overrides.jobId ?? 'job',
    url: overrides.url ?? 'https://example.com/watch',
    blobHash: overrides.blobHash ?? 'a'.repeat(64),
    tier: overrides.tier ?? 'private',
    archivedAt: overrides.archivedAt ?? 1_700_000_000,
    ...overrides,
  };
}

function failure(overrides: Partial<ArchiveFailureRecord>): ArchiveFailureRecord {
  return {
    jobId: overrides.jobId ?? 'failed-job',
    ownerPubkey: overrides.ownerPubkey ?? 'f'.repeat(64),
    url: overrides.url ?? 'https://blocked.example/article',
    reason: overrides.reason ?? 'site-blocked',
    message: overrides.message ?? 'Site blocked the archive capture.',
    failedAt: overrides.failedAt ?? 1_700_000_050,
    ...overrides,
  };
}

describe('archive record lookup preferences', () => {
  it('treats media metadata and media file bundles as media archives', async () => {
    const { isMediaArchiveRecord } = await import('$lib/stores/my-archives.js');

    expect(isMediaArchiveRecord(archive({ videoContentKey: 'yt:abcDEF123_4' }))).toBe(true);
    expect(isMediaArchiveRecord(archive({
      kind: 'webpage',
      contentType: 'text/html',
      files: [
        { role: 'html', blobHash: 'b'.repeat(64), url: 'https://example.com/watch' },
        { role: 'media', blobHash: 'c'.repeat(64), url: 'https://example.com/watch', contentType: 'video/mp4' },
      ],
    }))).toBe(true);
  });

  it('prefers a media archive over a newer page snapshot for the same bookmark', async () => {
    const { chooseArchiveRecord } = await import('$lib/stores/my-archives.js');
    const page = archive({
      jobId: 'page',
      blobHash: 'b'.repeat(64),
      kind: 'webpage',
      contentType: 'text/html',
      archivedAt: 1_700_000_100,
      completedAt: 1_700_000_100,
    });
    const media = archive({
      jobId: 'media',
      blobHash: 'c'.repeat(64),
      kind: 'media',
      contentType: 'video/mp4',
      archivedAt: 1_700_000_000,
      completedAt: 1_700_000_000,
    });

    expect(chooseArchiveRecord(page, media)).toBe(media);
    expect(chooseArchiveRecord(media, page)).toBe(media);
  });

  it('uses archive recency when comparing records of the same kind', async () => {
    const { chooseArchiveRecord } = await import('$lib/stores/my-archives.js');
    const older = archive({
      jobId: 'older',
      blobHash: 'b'.repeat(64),
      kind: 'media',
      completedAt: 1_700_000_000,
    });
    const newer = archive({
      jobId: 'newer',
      blobHash: 'c'.repeat(64),
      kind: 'media',
      completedAt: 1_700_000_010,
    });

    expect(chooseArchiveRecord(older, newer)).toBe(newer);
  });

  it('keeps server-known private archives in the icon lookup even when key repair is pending', async () => {
    const { myArchiveRecords, myArchives, replaceMyArchiveRecords } = await import('$lib/stores/my-archives.js');
    const record = archive({
      url: 'https://example.com/private-archive',
      blobHash: 'd'.repeat(64),
      tier: 'private',
    });

    replaceMyArchiveRecords('pubkey', [record]);

    expect(get(myArchiveRecords)).toEqual([record]);
    expect(get(myArchives).get(record.url)).toBe(record);
  });

  it('indexes URL variants so trailing slash differences do not hide archive icons', async () => {
    const { archiveLookupKeys, myArchives, replaceMyArchiveRecords } = await import('$lib/stores/my-archives.js');
    const root = archive({
      url: 'https://losslesscut.app/',
      blobHash: 'e'.repeat(64),
      tier: 'public',
    });
    const article = archive({
      url: 'https://all3dp.com/2/temp-tower-cura-tutorial/',
      blobHash: 'f'.repeat(64),
      tier: 'public',
    });

    replaceMyArchiveRecords('pubkey', [root, article]);

    expect(archiveLookupKeys(root.url)).toContain('https://losslesscut.app');
    expect(archiveLookupKeys(article.url)).toContain('https://all3dp.com/2/temp-tower-cura-tutorial');
    expect(get(myArchives).get('https://losslesscut.app')).toBe(root);
    expect(get(myArchives).get('https://all3dp.com/2/temp-tower-cura-tutorial')).toBe(article);
  });

  it('indexes archive failures but hides them when a successful archive exists', async () => {
    const { myArchiveFailures, replaceMyArchiveRecords } = await import('$lib/stores/my-archives.js');
    const blocked = failure({ url: 'https://archiveofourown.org/works/83355841' });
    const repaired = archive({
      url: 'https://example.com/repaired',
      blobHash: '2'.repeat(64),
      tier: 'public',
    });
    const staleFailure = failure({
      jobId: 'stale-failure',
      url: 'https://example.com/repaired/',
    });

    replaceMyArchiveRecords('pubkey', [repaired], [blocked, staleFailure]);

    expect(get(myArchiveFailures).get(blocked.url)).toBe(blocked);
    expect(get(myArchiveFailures).get('https://example.com/repaired')).toBeUndefined();
  });

  it('indexes YouTube webpage archives by video id for mobile/desktop URL variants', async () => {
    const { myArchivesByVideoKey, replaceMyArchiveRecords } = await import('$lib/stores/my-archives.js');
    const record = archive({
      url: 'https://m.youtube.com/watch?v=SVdTF4_QrTM&t=21s&pp=2AEVkAIB&ra=m',
      blobHash: '1'.repeat(64),
      tier: 'public',
      kind: 'webpage',
    });

    replaceMyArchiveRecords('pubkey', [record]);

    expect(get(myArchivesByVideoKey).get('yt:svdtf4_qrtm')).toBe(record);
  });
});
