import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnsignedEventTemplate } from '$lib/nostr/bookmarks.js';

vi.mock('$lib/nostr/private-bookmarks.js', () => ({
  addToPrivateSet: vi.fn(),
}));

vi.mock('$lib/nostr/publish.js', () => ({
  publishEventQueued: vi.fn(),
}));

vi.mock('$lib/api/client', () => ({
  api: {
    metadata: vi.fn(),
  },
}));

import { api } from '$lib/api/client';
import { addToPrivateSet } from '$lib/nostr/private-bookmarks.js';
import { publishEventQueued } from '$lib/nostr/publish.js';
import { saveBookmark } from '$lib/nostr/save-bookmark.js';

const mockedAddToPrivateSet = vi.mocked(addToPrivateSet);
const mockedPublishEventQueued = vi.mocked(publishEventQueued);
const mockedMetadata = vi.mocked(api.metadata);

function template(name: string, createdAt: number): UnsignedEventTemplate {
  return {
    kind: 30003,
    created_at: createdAt,
    tags: [['d', name]],
    content: '',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedMetadata.mockRejectedValue(new Error('metadata unavailable'));
});

describe('saveBookmark', () => {
  it('uses a caller-provided save time for public bookmark tags and optimistic state', async () => {
    mockedPublishEventQueued.mockResolvedValue({ eventId: 'evt-public', relays: ['wss://relay.deepmarks.org'] });
    const onOptimistic = vi.fn();

    const result = await saveBookmark({
      url: 'https://example.com/public',
      title: 'Public',
      tags: [],
      isPublic: true,
      pubkey: 'pubkey',
      savedAtMs: 1_700_000_000_123,
      onOptimistic,
    });

    const publishedTemplate = mockedPublishEventQueued.mock.calls[0]?.[0] as UnsignedEventTemplate;
    expect(publishedTemplate.tags).toContainEqual(['published_at', '1700000000']);
    expect(publishedTemplate.tags).toContainEqual(['published_at_ms', '1700000000123']);
    expect(onOptimistic).toHaveBeenCalledWith(expect.objectContaining({
      savedAt: 1_700_000_000,
      savedAtMs: 1_700_000_000_123,
    }));
    expect(result.bookmark.savedAt).toBe(1_700_000_000);
    expect(result.bookmark.savedAtMs).toBe(1_700_000_000_123);
  });

  it('returns a saved public bookmark when the publish is queued for retry', async () => {
    const onOptimistic = vi.fn();
    const rollback = vi.fn();
    mockedPublishEventQueued.mockResolvedValue({ eventId: 'evt-queued', relays: [] });

    const result = await saveBookmark({
      url: 'https://example.com/queued',
      title: 'Queued',
      tags: [],
      isPublic: true,
      pubkey: 'pubkey',
      onOptimistic: (bookmark) => {
        onOptimistic(bookmark);
        return rollback;
      },
    });

    expect(result.eventId).toBe('evt-queued');
    expect(result.publishRelayCount).toBe(0);
    expect(result.publishWarning).toBeUndefined();
    expect(result.bookmark.eventId).toBe('evt-queued');
    expect(onOptimistic).toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('fills missing title and description from URL metadata before publishing', async () => {
    mockedMetadata.mockResolvedValue({
      url: 'https://example.com/from-metadata',
      title: 'Fetched title',
      description: 'Fetched description',
      suggestedTags: [],
    });
    mockedPublishEventQueued.mockResolvedValue({ eventId: 'evt-metadata', relays: ['wss://relay.deepmarks.org'] });

    const result = await saveBookmark({
      url: 'https://example.com/from-metadata',
      tags: [],
      isPublic: true,
      pubkey: 'pubkey',
    });

    const publishedTemplate = mockedPublishEventQueued.mock.calls[0]?.[0] as UnsignedEventTemplate;
    expect(publishedTemplate.tags).toContainEqual(['title', 'Fetched title']);
    expect(publishedTemplate.tags).toContainEqual(['description', 'Fetched description']);
    expect(result.bookmark.title).toBe('Fetched title');
    expect(result.bookmark.description).toBe('Fetched description');
  });

  it('still throws when public bookmark signing fails before queueing', async () => {
    mockedPublishEventQueued.mockRejectedValue(new Error('No signer attached. Sign in first.'));
    const rollback = vi.fn();

    await expect(saveBookmark({
      url: 'https://example.com/not-signed',
      title: 'Not signed',
      tags: [],
      isPublic: true,
      pubkey: 'pubkey',
      onOptimistic: () => rollback,
    })).rejects.toThrow(/No signer attached/);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('publishes one per-item event for a private save', async () => {
    mockedAddToPrivateSet.mockResolvedValue(template('deepmarks-private-item:abc', 10));
    mockedPublishEventQueued.mockImplementation(async (event) => ({
      eventId: event.tags[0]?.[1] ?? '',
      relays: [],
    }));

    const result = await saveBookmark({
      url: 'https://example.com',
      title: 'Example',
      tags: [],
      isPublic: false,
      pubkey: 'pubkey',
    });

    expect(mockedPublishEventQueued).toHaveBeenCalledTimes(1);
    expect(result.eventId).toBe('deepmarks-private-item:abc');
  });

  it('returns saved private bookmark data when the publish is queued for retry', async () => {
    mockedAddToPrivateSet.mockResolvedValue(template('deepmarks-private-item:abc', 10));
    mockedPublishEventQueued.mockImplementation(async (event) => ({
      eventId: `${event.tags[0]?.[1] ?? 'item'}-event`,
      relays: [],
    }));

    const result = await saveBookmark({
      url: 'https://example.com/private-queued',
      title: 'Private queued',
      tags: [],
      isPublic: false,
      pubkey: 'pubkey',
    });

    expect(result.eventId).toBe('deepmarks-private-item:abc-event');
    expect(result.publishWarning).toBeUndefined();
    expect(result.bookmark.eventId).toBe('private:https://example.com/private-queued');
  });
});
