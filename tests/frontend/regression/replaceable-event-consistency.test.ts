// Regression guards for audit finding SYNC-F7 (2026-06 review): how the
// client decides which copy of a replaceable kind:39701 wins, and what an
// edit republishes.
//
// 1. Tie-break direction. NIP-01: for replaceable events with the same
//    created_at, the event with the LOWEST id is retained — that is what
//    strfry serves back. feed.ts's shouldReplace keeps the LARGEST id, so
//    two devices editing in the same second can each render a different
//    winner than the relay stores (and tests/frontend/lib/nostr/feed.test.ts
//    currently pins that larger-id behavior — when fixing, flip both).
//
// 2. Round-trip fidelity. Cross-device sort order depends on the
//    published_at / published_at_ms tags surviving an edit; archive
//    linkage depends on blossom / wayback / lightning / archive-tier
//    surviving. These pass today at the build/parse layer and guard
//    against the field-dropping bugs found in the extension edit path
//    (SYNC-F8).

import { describe, it, expect } from 'vitest';
import { shouldReplace } from '$lib/nostr/feed.js';
import {
  buildBookmarkEvent,
  parseBookmarkEvent,
  type ParsedBookmark,
} from '$lib/nostr/bookmarks.js';

function parsed(createdAt: number, eventId: string): ParsedBookmark {
  return {
    url: 'https://example.com/',
    title: 'x',
    description: '',
    tags: [],
    archivedForever: false,
    savedAt: createdAt,
    eventCreatedAt: createdAt,
    curator: 'a'.repeat(64),
    eventId,
  };
}

describe('replaceable-event tie-break vs NIP-01', () => {
  it('prefers the newer created_at regardless of id', () => {
    expect(shouldReplace({ key: 'k', bookmark: parsed(100, 'zzz') }, parsed(200, 'aaa'))).toBe(true);
    expect(shouldReplace({ key: 'k', bookmark: parsed(200, 'aaa') }, parsed(100, 'zzz'))).toBe(false);
  });

  // On a created_at tie NIP-01 retains the LOWEST id; relays (strfry
  // included) serve that copy. The client harmonizes with the relay
  // only if it picks the same winner. (Fixed in feed.ts shouldReplace
  // and own-bookmarks shouldReplaceBookmark.)
  it('on a created_at tie, retains the lexicographically lowest id like the relay does', () => {
    // incoming has the LOWER id -> per NIP-01 it should win.
    expect(shouldReplace({ key: 'k', bookmark: parsed(100, 'bbb') }, parsed(100, 'aaa'))).toBe(true);
    // incoming has the HIGHER id -> per NIP-01 the existing copy stays.
    expect(shouldReplace({ key: 'k', bookmark: parsed(100, 'aaa') }, parsed(100, 'bbb'))).toBe(false);
  });
});

describe('kind:39701 build → parse round-trip', () => {
  const event = {
    ...buildBookmarkEvent({
      url: 'https://example.com/article',
      title: 'Title',
      description: 'Desc',
      tags: ['alpha', 'beta'],
      publishedAt: 1_700_000_000,
      publishedAtMs: 1_700_000_000_123,
      lightning: 'tips@example.com',
      blossomHash: 'b'.repeat(64),
      waybackUrl: 'https://web.archive.org/web/2026/https://example.com/article',
      archivedForever: true,
    }),
    id: 'e'.repeat(64),
    pubkey: 'a'.repeat(64),
  };

  it('preserves every cross-device-critical field', () => {
    const back = parseBookmarkEvent(event);
    expect(back).not.toBeNull();
    expect(back!.url).toBe('https://example.com/article');
    expect(back!.title).toBe('Title');
    expect(back!.description).toBe('Desc');
    expect(back!.tags).toEqual(['alpha', 'beta']);
    expect(back!.publishedAt).toBe(1_700_000_000);
    // Millisecond save time is what keeps same-second saves ordered
    // identically on every device — losing it on an edit reintroduces
    // the cross-device sort-jitter bug.
    expect(back!.savedAtMs).toBe(1_700_000_000_123);
    expect(back!.lightning).toBe('tips@example.com');
    expect(back!.blossomHash).toBe('b'.repeat(64));
    expect(back!.waybackUrl).toContain('web.archive.org');
    expect(back!.archivedForever).toBe(true);
  });

  it('a rebuild from the parsed bookmark keeps archive linkage and timestamps', () => {
    const back = parseBookmarkEvent(event)!;
    const rebuilt = buildBookmarkEvent({
      url: back.url,
      title: back.title,
      description: back.description,
      tags: back.tags,
      publishedAt: back.publishedAt,
      publishedAtMs: back.savedAtMs,
      lightning: back.lightning,
      blossomHash: back.blossomHash,
      waybackUrl: back.waybackUrl,
      archivedForever: back.archivedForever,
    });
    const find = (name: string) => rebuilt.tags.find((t) => t[0] === name)?.[1];
    expect(find('published_at')).toBe('1700000000');
    expect(find('published_at_ms')).toBe('1700000000123');
    expect(find('lightning')).toBe('tips@example.com');
    expect(find('blossom')).toBe('b'.repeat(64));
    expect(find('wayback')).toContain('web.archive.org');
    expect(find('archive-tier')).toBe('forever');
  });
});
