import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnsignedEventTemplate } from './bookmarks.js';

vi.mock('./private-bookmarks.js', () => ({
  addToPrivateSet: vi.fn(),
}));

vi.mock('./publish.js', async () => {
  const publishEvent = vi.fn();
  return {
    publishEvent,
    // publishAll fans out templates through publishEvent — mirror the
    // real Promise.all so tests can stub publishEvent once and observe
    // concurrent behaviour.
    publishAll: (templates: readonly unknown[], pubkey: string) =>
      Promise.all(templates.map((t) => publishEvent(t as never, pubkey))),
  };
});

import { addToPrivateSet } from './private-bookmarks.js';
import { publishEvent } from './publish.js';
import { saveBookmark } from './save-bookmark.js';

const mockedAddToPrivateSet = vi.mocked(addToPrivateSet);
const mockedPublishEvent = vi.mocked(publishEvent);

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
});

describe('saveBookmark', () => {
  it('publishes private set replacement chunks concurrently', async () => {
    const templates = [
      template('deepmarks-private', 10),
      template('deepmarks-private-1', 11),
      template('deepmarks-private-2', 12),
    ];

    mockedAddToPrivateSet.mockResolvedValue({
      template: templates[0]!,
      templates,
      entries: [],
    });

    let active = 0;
    let maxActive = 0;
    mockedPublishEvent.mockImplementation(async (event) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        eventId: event.tags[0]?.[1] ?? '',
        relays: [],
      };
    });

    const result = await saveBookmark({
      url: 'https://example.com',
      title: 'Example',
      tags: [],
      isPublic: false,
      pubkey: 'pubkey',
    });

    expect(mockedPublishEvent).toHaveBeenCalledTimes(3);
    expect(maxActive).toBeGreaterThan(1);
    expect(result.eventId).toBe('deepmarks-private-2');
  });
});
