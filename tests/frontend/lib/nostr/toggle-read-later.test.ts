import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('$lib/nostr/publish.js', () => ({
  publishEventQueued: vi.fn(),
}));

vi.mock('$lib/nostr/private-bookmarks.js', () => ({
  updatePrivateSetEntry: vi.fn(),
}));

const rollbackSpy = vi.hoisted(() => vi.fn());
vi.mock('$lib/stores/own-bookmarks', () => ({
  rememberOwnBookmark: vi.fn(),
  rememberOwnBookmarkWithRollback: vi.fn(() => rollbackSpy),
}));

import { publishEventQueued } from '$lib/nostr/publish.js';
import { updatePrivateSetEntry } from '$lib/nostr/private-bookmarks.js';
import { rememberOwnBookmark, rememberOwnBookmarkWithRollback } from '$lib/stores/own-bookmarks';
import { toggleReadLater } from '$lib/nostr/toggle-read-later.js';

const mockedPublishEventQueued = vi.mocked(publishEventQueued);
const mockedUpdatePrivateSetEntry = vi.mocked(updatePrivateSetEntry);
const mockedRememberOwnBookmark = vi.mocked(rememberOwnBookmark);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toggleReadLater', () => {
  it('keeps the optimistic public toggle when publish is queued for retry', async () => {
    mockedPublishEventQueued.mockResolvedValue({ eventId: 'queued-toggle-event', relays: [] });

    const result = toggleReadLater({
      url: 'https://example.com',
      title: 'Example',
      description: '',
      tags: [],
      savedAt: 1_700_000_000,
      curator: 'a'.repeat(64),
      eventId: 'event-1',
      archivedForever: false,
    }, 'a'.repeat(64));

    await expect(result.publish).resolves.toEqual({ eventId: 'queued-toggle-event' });
    expect(result.bookmark.tags).toContain('toread');
    expect(mockedRememberOwnBookmark).toHaveBeenLastCalledWith(
      expect.objectContaining({ eventId: 'queued-toggle-event', tags: ['toread'] }),
      true,
    );
  });

  it('preserves imported private NIP-51 note rows when toggling read-later', async () => {
    mockedUpdatePrivateSetEntry.mockResolvedValue({
      kind: 30003,
      created_at: 1_700_000_100,
      tags: [['d', 'deepmarks-private-item:abc']],
      content: 'ciphertext',
    });
    mockedPublishEventQueued.mockResolvedValue({ eventId: 'private-toggle-event', relays: [] });

    const result = toggleReadLater({
      url: 'https://primal.net/e/abc',
      title: 'Nostr post',
      description: '',
      tags: [],
      savedAt: 1_700_000_000,
      curator: 'a'.repeat(64),
      eventId: 'nip51-note:list-event:target-event',
      archivedForever: false,
      visibility: 'private',
    } as Parameters<typeof toggleReadLater>[0], 'a'.repeat(64));

    await expect(result.publish).resolves.toEqual({ eventId: 'private-toggle-event' });
    expect(mockedUpdatePrivateSetEntry).toHaveBeenCalledOnce();
    expect(mockedPublishEventQueued).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 30003 }),
      'a'.repeat(64),
      expect.any(Object),
    );
    // The optimistic write now goes through the rollback-capable helper
    // (2026-08-23 review — the plain re-remember was a no-op revert).
    expect(rememberOwnBookmarkWithRollback).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['toread'] }),
      false,
    );
  });
});

describe('toggleReadLater rollback (2026-08-23 review)', () => {
  it('rolls back the optimistic store snapshot when the publish rejects', async () => {
    // The old revert re-remembered the ORIGINAL bookmark, but the merge
    // keeps the newest eventCreatedAt — the failed optimistic copy — so
    // the UI + localStorage permanently showed a toggle that never
    // published.
    rollbackSpy.mockClear();
    vi.mocked(rememberOwnBookmarkWithRollback).mockClear();
    mockedPublishEventQueued.mockRejectedValueOnce(new Error('signer refused'));

    const { publish } = toggleReadLater(
      {
        eventId: 'e'.repeat(64),
        url: 'https://example.com/a',
        title: 'a',
        description: '',
        tags: [],
        archivedForever: false,
        savedAt: 100,
        eventCreatedAt: 100,
        curator: 'a'.repeat(64),
      } as never,
      'a'.repeat(64),
    );

    await expect(publish).rejects.toThrow('signer refused');
    expect(rememberOwnBookmarkWithRollback).toHaveBeenCalledTimes(1);
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
  });
});
