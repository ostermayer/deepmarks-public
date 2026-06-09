// Regression guard for audit finding NOTE-F1 (2026-06 review): a bookmarked
// kind:1 note whose target event is not yet on the relay renders as nothing,
// and resolveEvent caches the miss for the whole session — the note never
// appears even after the server-side mirror catches up seconds later. The
// user reads that as "my bookmark is gone".
//
// primeEvents already retries cached misses (covered by
// tests/frontend/lib/nostr/event-resolver.test.ts). FIXED for resolveEvent
// too: a fresh resolve call refetches a settled miss (in-flight dedup
// prevents stacking) — permanent guard.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const fetchEvents = vi.fn();
const fetchEvent = vi.fn();

vi.mock('$lib/nostr/ndk.js', () => ({
  getNdk: () => ({ fetchEvent, fetchEvents }),
}));

import { __resetEventCacheForTests, resolveEvent } from '$lib/nostr/event-resolver.js';

const id = 'a'.repeat(64);

beforeEach(() => {
  fetchEvent.mockReset();
  fetchEvents.mockReset();
  __resetEventCacheForTests();
});

describe('resolveEvent after a relay miss', () => {
  it('retries a session-cached miss so late-mirrored notes become visible', async () => {
    // First lookup: the note is not on the relay yet.
    fetchEvent.mockResolvedValueOnce(null);
    const first = resolveEvent(id);
    await vi.waitFor(() => expect(fetchEvent).toHaveBeenCalled());
    // Let the first fetch fully settle (its finally clears the
    // in-flight flag) before the retrying resolve call.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(get(first)).toBeNull();

    // The mirror catches up; the same id is requested again this session.
    fetchEvent.mockResolvedValueOnce({
      id,
      kind: 1,
      pubkey: 'b'.repeat(64),
      created_at: 1_770_000_000,
      tags: [],
      content: 'now mirrored',
    });
    const second = resolveEvent(id);
    await vi.waitFor(() => expect(get(second)?.content).toBe('now mirrored'));
  });
});
