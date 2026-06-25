import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('$lib/nostr/publish.js', () => ({
  publishEventQueued: vi.fn(),
}));

vi.mock('$lib/nostr/private-bookmarks.js', () => ({
  updatePrivateSetEntry: vi.fn(),
}));

vi.mock('$lib/stores/own-bookmarks', () => ({
  rememberOwnBookmark: vi.fn(),
}));

import { publishEventQueued } from '$lib/nostr/publish.js';
import { updatePrivateSetEntry } from '$lib/nostr/private-bookmarks.js';
import { rememberOwnBookmark } from '$lib/stores/own-bookmarks';
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
    expect(mockedRememberOwnBookmark).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['toread'] }),
      false,
    );
  });
});
