import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBookmarkEvent } from '$lib/nostr/bookmarks';
import { publishEventQueued } from '$lib/nostr/publish';
import { updatePrivateSetEntry } from '$lib/nostr/private-bookmarks';
import { rememberArchiveRecord } from '$lib/stores/my-archives';
import { finalizeBookmarkArchive } from '$lib/archives/finalize.js';

vi.mock('$lib/nostr/bookmarks', () => ({
  buildBookmarkEvent: vi.fn((input) => ({ kind: 39701, content: '', tags: [], input })),
}));

vi.mock('$lib/nostr/publish', () => ({
  publishEventQueued: vi.fn(),
}));

vi.mock('$lib/nostr/private-bookmarks', () => ({
  updatePrivateSetEntry: vi.fn(),
}));

vi.mock('$lib/stores/my-archives', () => ({
  rememberArchiveRecord: vi.fn(),
}));

describe('finalizeBookmarkArchive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let publishCount = 0;
    vi.mocked(publishEventQueued).mockImplementation(async () => ({
      eventId: `event-${++publishCount}`,
      relays: ['wss://relay.example'],
    }));
    vi.mocked(updatePrivateSetEntry).mockResolvedValue(
      { kind: 30003, content: 'item', tags: [], created_at: 1 },
    );
  });

  it('retags public bookmarks and records the archive locally', async () => {
    const result = await finalizeBookmarkArchive(
      'pubkey',
      { url: 'https://example.com', title: 'Example', tags: ['web'], isPublic: true, savedAt: 1_700_000_000 },
      { hash: 'blob-hash', wayback: 'https://web.archive.org/example' },
    );

    expect(result.eventId).toBe('event-1');
    expect(rememberArchiveRecord).toHaveBeenCalledWith('pubkey', expect.objectContaining({
      jobId: 'blob-hash',
      url: 'https://example.com',
      blobHash: 'blob-hash',
      tier: 'public',
      source: 'app',
      archivedAt: 1_700_000_000,
      completedAt: expect.any(Number),
      bookmarkSavedAt: 1_700_000_000,
    }));
    expect(buildBookmarkEvent).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://example.com',
      blossomHash: 'blob-hash',
      waybackUrl: 'https://web.archive.org/example',
      archivedForever: true,
    }));
    expect(publishEventQueued).toHaveBeenCalledTimes(1);
  });

  it('retags private bookmarks through the encrypted set', async () => {
    const result = await finalizeBookmarkArchive(
      'pubkey',
      { url: 'https://example.com', tags: [], lightning: 'alice@example.com', isPublic: false },
      { hash: 'blob-hash' },
    );

    expect(result.eventId).toBe('event-1');
    expect(rememberArchiveRecord).toHaveBeenCalledWith('pubkey', expect.objectContaining({
      blobHash: 'blob-hash',
      tier: 'private',
    }));
    expect(updatePrivateSetEntry).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://example.com',
      lightning: 'alice@example.com',
      blossomHash: 'blob-hash',
      archivedForever: true,
    }), 'pubkey');
    expect(publishEventQueued).toHaveBeenCalledTimes(1);
  });
});
