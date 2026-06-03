import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./publish.js', () => ({
  publishEventQueued: vi.fn(),
}));

vi.mock('./private-bookmarks.js', () => ({
  updatePrivateSetEntry: vi.fn(),
}));

vi.mock('$lib/stores/own-bookmarks', () => ({
  rememberOwnBookmark: vi.fn(),
}));

import { publishEventQueued } from './publish.js';
import { rememberOwnBookmark } from '$lib/stores/own-bookmarks';
import { toggleReadLater } from './toggle-read-later.js';

const mockedPublishEventQueued = vi.mocked(publishEventQueued);
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
});
