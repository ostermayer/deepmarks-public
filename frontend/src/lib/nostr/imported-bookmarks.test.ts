import { describe, it, expect } from 'vitest';
import {
  extractImportedNoteRefs,
  extractImportedUrls,
  mergeImportedReplacement,
} from './imported-bookmarks.js';
import type { SignedEventLike } from './bookmarks.js';

function ev(overrides: Partial<SignedEventLike> & { kind: number; tags: string[][] }): SignedEventLike {
  return {
    id: 'ev1',
    pubkey: 'curator',
    created_at: 1_700_000_000,
    content: '',
    ...overrides,
  };
}

describe('extractImportedUrls', () => {
  it('returns one bookmark per r-tag on a kind:10003 list', () => {
    const out = extractImportedUrls(
      ev({
        kind: 10003,
        tags: [
          ['r', 'https://example.com/a'],
          ['r', 'https://example.com/b'],
          ['e', 'some-note-id'],
        ],
      }),
    );
    expect(out).toHaveLength(2);
    expect(out.map((b) => b.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('works on kind:30003 parametric-replaceable lists', () => {
    const out = extractImportedUrls(
      ev({
        kind: 30003,
        tags: [
          ['d', 'reading-list'],
          ['r', 'https://example.com'],
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.listKind).toBe(30003);
    expect(out[0]?.listIdentifier).toBe('reading-list');
  });

  it('ignores non-list event kinds', () => {
    expect(
      extractImportedUrls(ev({ kind: 39701, tags: [['r', 'https://x']] })),
    ).toEqual([]);
    expect(
      extractImportedUrls(ev({ kind: 1, tags: [['r', 'https://x']] })),
    ).toEqual([]);
  });

  it('skips r-tags that are not http(s) URLs', () => {
    const out = extractImportedUrls(
      ev({
        kind: 10003,
        tags: [
          ['r', 'mailto:foo@bar'],
          ['r', 'magnet:?xt=urn:btih:123'],
          ['r', 'https://ok.example'],
          ['r', ''],
        ],
      }),
    );
    expect(out.map((b) => b.url)).toEqual(['https://ok.example']);
  });

  it('uses tag[2] as title when present, otherwise falls back to the URL', () => {
    const out = extractImportedUrls(
      ev({
        kind: 10003,
        tags: [
          ['r', 'https://a.example'],
          ['r', 'https://b.example', 'B has a title'],
        ],
      }),
    );
    expect(out[0]?.title).toBe('https://a.example');
    expect(out[1]?.title).toBe('B has a title');
  });

  it('carries curator pubkey + list event id through to each record', () => {
    const out = extractImportedUrls(
      ev({
        id: 'LIST_EVENT_ID',
        pubkey: 'alice',
        kind: 10003,
        tags: [['r', 'https://x']],
      }),
    );
    expect(out[0]?.curator).toBe('alice');
    expect(out[0]?.eventId).toBe('LIST_EVENT_ID');
    expect(out[0]?.source).toBe('nip51-list');
  });

  it('uses the event created_at as the initial savedAt fallback', () => {
    const out = extractImportedUrls(
      ev({ kind: 10003, created_at: 1_800_000_000, tags: [['r', 'https://x']] }),
    );
    expect(out[0]?.savedAt).toBe(1_800_000_000);
    expect(out[0]?.eventCreatedAt).toBe(1_800_000_000);
  });

  it('ignores r-tags with non-string values', () => {
    const out = extractImportedUrls(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ev({ kind: 10003, tags: [['r', 42 as any]] }),
    );
    expect(out).toEqual([]);
  });
});

describe('extractImportedNoteRefs', () => {
  it('keeps separate stable savedAt and listCreatedAt fields', () => {
    const out = extractImportedNoteRefs(
      ev({
        kind: 10003,
        created_at: 1_800_000_000,
        tags: [['e', 'a'.repeat(64)]],
      }),
    );

    expect(out[0]?.savedAt).toBe(1_800_000_000);
    expect(out[0]?.listCreatedAt).toBe(1_800_000_000);
  });
});

describe('mergeImportedReplacement', () => {
  it('updates list metadata from a newer replacement without moving savedAt', () => {
    const existing = {
      savedAt: 1_700_000_000,
      eventCreatedAt: 1_700_000_000,
      eventId: 'old',
      title: 'Old title',
    };
    const incoming = {
      savedAt: 1_800_000_000,
      eventCreatedAt: 1_800_000_000,
      eventId: 'new',
      title: 'New title',
    };

    expect(mergeImportedReplacement(existing, incoming)).toEqual({
      savedAt: 1_700_000_000,
      eventCreatedAt: 1_800_000_000,
      eventId: 'new',
      title: 'New title',
      savedAtMs: undefined,
    });
  });

  it('ignores older replacement events after a newer list has been seen', () => {
    const existing = {
      savedAt: 1_700_000_000,
      eventCreatedAt: 1_800_000_000,
      eventId: 'new',
    };
    const incoming = {
      savedAt: 1_600_000_000,
      eventCreatedAt: 1_600_000_000,
      eventId: 'old',
    };

    expect(mergeImportedReplacement(existing, incoming)).toBeNull();
  });
});
