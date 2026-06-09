// Regression guards for audit finding SYNC-F5 (2026-06 review), FIXED:
// public deletes didn't propagate across devices. Two failure modes:
//
//   1. Arrival-order race — a kind:39701 copy arriving AFTER its own
//      kind:5 (multi-relay ordering, cache replay) was re-inserted into
//      the feed and persisted, resurrecting the deleted bookmark.
//   2. The own-bookmarks server-cache merge is merge-only-never-remove,
//      so a delete made on another device never left this device's view
//      (now pruned via the feed's deletion-observer hook).
//
// Also pins the NIP-09 author check: a forged kind:5 naming someone
// else's coordinate must not hide their bookmark.

import { describe, expect, it } from 'vitest';
import {
  applyBookmarkDeletion,
  createBookmarkDeletionMemory,
  deletionMemoryCovers,
  rememberBookmarkDeletion,
} from '$lib/nostr/feed.js';
import type { ParsedBookmark, SignedEventLike } from '$lib/nostr/bookmarks.js';

const OWNER = 'a'.repeat(64);
const MALLORY = 'e'.repeat(64);
const URL = 'https://example.com/article';

function deletion(pubkey: string, coordinatePubkey: string, createdAt: number): SignedEventLike {
  return {
    id: 'd'.repeat(64),
    kind: 5,
    pubkey,
    created_at: createdAt,
    tags: [['a', `39701:${coordinatePubkey}:${URL}`]],
    content: '',
  };
}

function bookmark(createdAt: number): ParsedBookmark {
  return {
    url: URL,
    title: 't',
    description: '',
    tags: [],
    archivedForever: false,
    savedAt: createdAt,
    eventCreatedAt: createdAt,
    curator: OWNER,
    eventId: 'b'.repeat(64),
  };
}

describe('feed deletion memory (arrival-order race)', () => {
  it('drops a bookmark copy that arrives after its own deletion', () => {
    const memory = createBookmarkDeletionMemory();
    const observed = rememberBookmarkDeletion(memory, deletion(OWNER, OWNER, 2_000));

    expect(observed).toEqual([{ pubkey: OWNER, url: URL, deletedAt: 2_000 }]);
    expect(deletionMemoryCovers(memory, bookmark(1_500))).toBe(true);
  });

  it('lets a genuinely newer re-save win over an older deletion', () => {
    const memory = createBookmarkDeletionMemory();
    rememberBookmarkDeletion(memory, deletion(OWNER, OWNER, 2_000));

    expect(deletionMemoryCovers(memory, bookmark(2_500))).toBe(false);
  });

  it('ignores forged deletions naming someone else\'s coordinate (NIP-09)', () => {
    const memory = createBookmarkDeletionMemory();
    const observed = rememberBookmarkDeletion(memory, deletion(MALLORY, OWNER, 2_000));

    expect(observed).toEqual([]);
    expect(deletionMemoryCovers(memory, bookmark(1_500))).toBe(false);
  });

  it('keeps only the newest deletion time per coordinate', () => {
    const memory = createBookmarkDeletionMemory();
    rememberBookmarkDeletion(memory, deletion(OWNER, OWNER, 2_000));
    const second = rememberBookmarkDeletion(memory, deletion(OWNER, OWNER, 1_000));

    expect(second).toEqual([]); // older — nothing new observed
    expect(deletionMemoryCovers(memory, bookmark(1_500))).toBe(true);
  });
});

describe('applyBookmarkDeletion author check', () => {
  function entryMap() {
    const b = bookmark(1_500);
    return new Map([[`${OWNER}::${URL}`, { key: `${OWNER}::${URL}`, bookmark: b }]]);
  }

  it('removes the entry for an authentic own-author deletion', () => {
    const byKey = entryMap();
    const changed = applyBookmarkDeletion(byKey, deletion(OWNER, OWNER, 2_000));

    expect(changed).toBe(true);
    expect(byKey.size).toBe(0);
  });

  it('ignores a forged deletion from a different author', () => {
    const byKey = entryMap();
    const changed = applyBookmarkDeletion(byKey, deletion(MALLORY, OWNER, 2_000));

    expect(changed).toBe(false);
    expect(byKey.size).toBe(1);
  });
});
