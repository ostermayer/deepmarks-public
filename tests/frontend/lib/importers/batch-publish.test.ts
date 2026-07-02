import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BookmarkInput } from '$lib/nostr/bookmarks';

// Mock the publish + private-set modules so we can assert the batch logic
// without touching real relays or signers.

vi.mock('$lib/nostr/publish', () => ({
  publishEventQueued: vi.fn()
}));
vi.mock('$lib/nostr/private-bookmarks', () => ({
  assertPrivateSetRewriteSafe: vi.fn(),
  bookmarkInputToInnerTags: (i: BookmarkInput) => [['d', i.url]],
  buildPrivateSetReplacementEventStream: vi.fn(() => streamFrom([template('ciphertext')])),
  privateSetReplacementCount: () => 1,
  fetchOwnPrivateSet: vi.fn(async () => ({ entries: [] }))
}));
vi.mock('$lib/stores/session', () => ({
  isTransientSignerConnectionError: (error: unknown) =>
    /Could not establish connection|Receiving end does not exist/i.test(
      error instanceof Error ? error.message : String(error ?? ''),
    ),
  refreshBrowserExtensionSigner: vi.fn(async () => true),
}));

import { publishBatch, type BatchEvent } from '$lib/importers/batch-publish.js';
import { publishEventQueued } from '$lib/nostr/publish';
import { fetchOwnPrivateSet, buildPrivateSetReplacementEventStream } from '$lib/nostr/private-bookmarks';
import { refreshBrowserExtensionSigner } from '$lib/stores/session';

const mockedPublish = publishEventQueued as unknown as ReturnType<typeof vi.fn>;
const mockedFetchSet = fetchOwnPrivateSet as unknown as ReturnType<typeof vi.fn>;
const mockedBuildSet = buildPrivateSetReplacementEventStream as unknown as ReturnType<typeof vi.fn>;
const mockedRefreshSigner = refreshBrowserExtensionSigner as unknown as ReturnType<typeof vi.fn>;

const inputs: BookmarkInput[] = [
  { url: 'https://a.test', tags: [] },
  { url: 'https://b.test', tags: [] },
  { url: 'https://c.test', tags: [] }
];

function template(content: string, d = 'deepmarks-private') {
  return { kind: 30003, created_at: 0, tags: [['d', d]], content };
}

async function* streamFrom(templates: ReturnType<typeof template>[]) {
  for (let i = 0; i < templates.length; i++) {
    yield { index: i, count: templates.length, setName: templates[i]!.tags[0]![1]!, entryCount: 1, template: templates[i]! };
  }
}

beforeEach(() => {
  mockedPublish.mockReset();
  mockedFetchSet.mockReset();
  mockedBuildSet.mockReset();
  mockedFetchSet.mockResolvedValue({ entries: [] });
  mockedBuildSet.mockImplementation(() => streamFrom([template('ciphertext')]));
  mockedRefreshSigner.mockClear();
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

  it('preserves imported savedAt timestamps in the optimistic result', async () => {
    mockedPublish.mockResolvedValue({ eventId: 'imported-id', relays: [] });
    const events = (await collect(
      publishBatch(
        [{
          url: 'https://imported.test',
          tags: [],
          publishedAt: 1_700_000_000,
          publishedAtMs: 1_700_000_000_456,
        }],
        { visibility: 'public', ownerPubkey: 'pub' },
      )
    )) as BatchEvent[];

    expect(events[0]?.bookmark?.savedAt).toBe(1_700_000_000);
    expect(events[0]?.bookmark?.savedAtMs).toBe(1_700_000_000_456);
  });
});

describe('publishBatch — private visibility', () => {
  it('publishes ONE updated set after preparing every input', async () => {
    mockedPublish.mockResolvedValue({ eventId: 'set-id', relays: [] });
    const events = (await collect(
      publishBatch(inputs, { visibility: 'private', ownerPubkey: 'pub' })
    )) as BatchEvent[];
    // 3 per-item prepared events + 1 encryption progress + 1 final set-publish event.
    expect(events).toHaveLength(5);
    expect(events.slice(0, 3).every((e) => e.status === 'prepared')).toBe(true);
    expect(events[3]).toMatchObject({ status: 'prepared', phase: 'private-set-encrypt', url: '<encrypt set 1/1>' });
    expect(events[4]).toMatchObject({ status: 'ok', url: '<set 1/1>', eventId: 'set-id' });
    expect(mockedPublish).toHaveBeenCalledTimes(1);
  });

  it('publishes every private-set chunk returned by the chunk builder', async () => {
    mockedBuildSet.mockImplementationOnce(() => streamFrom([
      template('chunk-0'),
      template('chunk-1', 'deepmarks-private-1'),
    ]));
    mockedPublish
      .mockResolvedValueOnce({ eventId: 'chunk-0-id', relays: [] })
      .mockResolvedValueOnce({ eventId: 'chunk-1-id', relays: [] });

    const events = (await collect(
      publishBatch(inputs, { visibility: 'private', ownerPubkey: 'pub' })
    )) as BatchEvent[];

    expect(events.at(-2)).toMatchObject({ status: 'ok', url: '<set 1/2>' });
    expect(events.at(-1)).toMatchObject({ status: 'ok', url: '<set 2/2>' });
    expect(mockedPublish).toHaveBeenCalledTimes(2);
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
    expect(events.at(-1)?.error).toContain('private import was not completed or cached');
  });

  it('reports a transient extension disconnect while encrypting the private set', async () => {
    mockedBuildSet.mockImplementationOnce(async function* () {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });
    const events = (await collect(
      publishBatch(inputs, { visibility: 'private', ownerPubkey: 'pub' })
    )) as BatchEvent[];

    expect(events.at(-1)?.status).toBe('failed');
    expect(events.at(-1)?.phase).toBe('private-set-encrypt');
    expect(events.at(-1)?.error).toContain('Could not establish connection');
    expect(events.at(-1)?.error).toContain('private import was not completed or cached');
    expect(mockedBuildSet).toHaveBeenCalledTimes(1);
  });
});
