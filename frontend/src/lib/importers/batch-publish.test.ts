import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BookmarkInput } from '$lib/nostr/bookmarks';

// Mock the publish + private-set modules so we can assert the batch logic
// without touching real relays or signers.

vi.mock('$lib/nostr/publish', () => ({
  publishEvent: vi.fn()
}));
vi.mock('$lib/nostr/private-bookmarks', () => ({
  bookmarkInputToInnerTags: (i: BookmarkInput) => [['d', i.url]],
  buildPrivateSetEvent: vi.fn(async () => ({
    kind: 30003,
    created_at: 0,
    tags: [['d', 'deepmarks-private']],
    content: 'ciphertext'
  })),
  fetchOwnPrivateSet: vi.fn(async () => ({ entries: [] }))
}));

import { publishBatch, type BatchEvent } from './batch-publish.js';
import { publishEvent } from '$lib/nostr/publish';
import { fetchOwnPrivateSet, buildPrivateSetEvent } from '$lib/nostr/private-bookmarks';

const mockedPublish = publishEvent as unknown as ReturnType<typeof vi.fn>;
const mockedFetchSet = fetchOwnPrivateSet as unknown as ReturnType<typeof vi.fn>;
const mockedBuildSet = buildPrivateSetEvent as unknown as ReturnType<typeof vi.fn>;

const inputs: BookmarkInput[] = [
  { url: 'https://a.test', tags: [] },
  { url: 'https://b.test', tags: [] },
  { url: 'https://c.test', tags: [] }
];

beforeEach(() => {
  mockedPublish.mockReset();
  mockedFetchSet.mockReset();
  mockedBuildSet.mockReset();
  mockedFetchSet.mockResolvedValue({ entries: [] });
  mockedBuildSet.mockResolvedValue({
    kind: 30003,
    created_at: 0,
    tags: [['d', 'deepmarks-private']],
    content: 'ciphertext'
  });
});

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe('publishBatch — public visibility', () => {
  it('emits one ok event per input', async () => {
    let n = 0;
    mockedPublish.mockImplementation(async () => ({ eventId: `id-${n++}`, relays: [] }));
    const events = (await collect(
      publishBatch(inputs, { visibility: 'public', ownerPubkey: 'pub' })
    )) as BatchEvent[];
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.status === 'ok')).toBe(true);
    expect(events.map((e) => e.url)).toEqual([
      'https://a.test',
      'https://b.test',
      'https://c.test'
    ]);
    expect(mockedPublish).toHaveBeenCalledTimes(3);
  });

  it('reports failed items without aborting the batch', async () => {
    mockedPublish
      .mockResolvedValueOnce({ eventId: 'ok-1', relays: [] })
      .mockRejectedValueOnce(new Error('relay down'))
      .mockResolvedValueOnce({ eventId: 'ok-3', relays: [] });
    const events = (await collect(
      publishBatch(inputs, { visibility: 'public', ownerPubkey: 'pub', concurrency: 1 })
    )) as BatchEvent[];
    expect(events.map((e) => e.status)).toEqual(['ok', 'failed', 'ok']);
    expect(events[1]?.error).toContain('relay down');
  });
});

describe('publishBatch — private visibility', () => {
  it('publishes ONE updated set after listing every input', async () => {
    mockedPublish.mockResolvedValue({ eventId: 'set-id', relays: [] });
    const events = (await collect(
      publishBatch(inputs, { visibility: 'private', ownerPubkey: 'pub' })
    )) as BatchEvent[];
    // 3 per-item ok events + 1 final set-publish event.
    expect(events).toHaveLength(4);
    expect(events.slice(0, 3).every((e) => e.status === 'ok')).toBe(true);
    expect(events[3]).toMatchObject({ status: 'ok', url: '<set>', eventId: 'set-id' });
    expect(mockedPublish).toHaveBeenCalledTimes(1);
  });

  it('appends to an existing private set rather than replacing it', async () => {
    mockedFetchSet.mockResolvedValueOnce({
      entries: [[['d', 'https://existing.test']]]
    });
    mockedPublish.mockResolvedValue({ eventId: 'set-id', relays: [] });
    await collect(publishBatch(inputs, { visibility: 'private', ownerPubkey: 'pub' }));
    expect(mockedBuildSet).toHaveBeenCalledTimes(1);
    const setArg = mockedBuildSet.mock.calls[0]![0] as { entries: unknown[] };
    expect(setArg.entries).toHaveLength(4); // 1 existing + 3 new
  });

  it('reports a synthetic failure if the set publish itself fails', async () => {
    mockedPublish.mockRejectedValue(new Error('relay refused'));
    const events = (await collect(
      publishBatch(inputs, { visibility: 'private', ownerPubkey: 'pub' })
    )) as BatchEvent[];
    expect(events.at(-1)?.status).toBe('failed');
    expect(events.at(-1)?.error).toContain('relay refused');
  });
});
