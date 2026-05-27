import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const fetchEvents = vi.fn();
const fetchEvent = vi.fn();

vi.mock('./ndk.js', () => ({
  getNdk: () => ({ fetchEvent, fetchEvents })
}));

import { __resetEventCacheForTests, primeEvents, resolveEvent } from './event-resolver.js';

const id = 'a'.repeat(64);

beforeEach(() => {
  fetchEvent.mockReset();
  fetchEvents.mockReset();
  __resetEventCacheForTests();
});

describe('primeEvents', () => {
  it('retries cached unresolved events so hidden note bookmarks can recover', async () => {
    fetchEvents.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set([{
      id,
      kind: 1,
      pubkey: 'b'.repeat(64),
      created_at: 1770000000,
      tags: [],
      content: 'resolved note',
    }]));

    await primeEvents([id]);
    const store = resolveEvent(id);
    expect(get(store)).toBeNull();

    await primeEvents([id]);

    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(get(store)?.content).toBe('resolved note');
  });
});
