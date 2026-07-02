import { describe, expect, it, vi } from 'vitest';
import type { Event as NostrEvent } from 'nostr-tools';
import {
  allowBookmarkedNoteTargets,
  BOOKMARKED_NOTE_TARGET_PREFIX,
  BOOKMARKED_NOTE_TARGET_TTL_S,
  collectBookmarkedNoteTargets,
  normalizeEventIds,
} from '@src/bookmarked-note-targets.js';

function ev(overrides: Partial<NostrEvent>): NostrEvent {
  return {
    id: '0'.repeat(64),
    pubkey: '1'.repeat(64),
    created_at: 1_700_000_000,
    kind: 10003,
    tags: [],
    content: '',
    sig: '2'.repeat(128),
    ...overrides,
  };
}

describe('collectBookmarkedNoteTargets', () => {
  it('extracts kind:1 targets from public e-tags and relay hints', () => {
    const id = 'a'.repeat(64);
    const out = collectBookmarkedNoteTargets([
      ev({
        kind: 10003,
        tags: [
          ['e', id.toUpperCase(), 'wss://relay.example/'],
          ['e', 'not-hex'],
        ],
      }),
    ]);

    expect(out.ids).toEqual([id]);
    expect(out.idSet.has(id)).toBe(true);
    expect(out.relays).toEqual(['wss://relay.example']);
  });

  it('extracts targets from Nostr note URLs in r-tags and 39701 d-tags', () => {
    const id = 'b'.repeat(64);
    const out = collectBookmarkedNoteTargets([
      ev({
        kind: 10003,
        tags: [['r', `https://primal.net/e/${id}`]],
      }),
      ev({
        kind: 39701,
        tags: [['d', `https://njump.me/${id}`]],
      }),
    ]);

    expect(out.ids).toEqual([id]);
  });

  it('ignores non-bookmark event kinds', () => {
    const out = collectBookmarkedNoteTargets([
      ev({
        kind: 3,
        tags: [['e', 'c'.repeat(64)]],
      }),
    ]);
    expect(out.ids).toEqual([]);
  });
});

describe('normalizeEventIds', () => {
  it('lowercases, validates, and de-dupes event ids', () => {
    expect(normalizeEventIds([
      'A'.repeat(64),
      'a'.repeat(64),
      'not-an-id',
      'b'.repeat(63),
    ])).toEqual(['a'.repeat(64)]);
  });
});

describe('allowBookmarkedNoteTargets', () => {
  it('writes strfry allowlist keys with a TTL', async () => {
    const pipeline = {
      set: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => []),
    };
    const redis = {
      pipeline: vi.fn(() => pipeline),
    };

    await allowBookmarkedNoteTargets(redis as never, ['A'.repeat(64), 'bad']);

    expect(redis.pipeline).toHaveBeenCalledOnce();
    expect(pipeline.set).toHaveBeenCalledWith(
      `${BOOKMARKED_NOTE_TARGET_PREFIX}${'a'.repeat(64)}`,
      '1',
      'EX',
      BOOKMARKED_NOTE_TARGET_TTL_S,
    );
    expect(pipeline.exec).toHaveBeenCalledOnce();
  });
});
