// Tests the pre-signed-event verification path used by
// POST /api/v1/bookmarks and DELETE /api/v1/bookmarks/:eventId.
//
// The handlers themselves live inside the closure of `start()` in index.ts,
// so instead of booting Fastify we replicate the exact check sequence and
// prove each failure / success path. This is the verification contract
// the API is promising to its callers.

import { describe, it, expect } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { bookmarkEventToJson } from './api-helpers.js';

type SignedEvent = ReturnType<typeof finalizeEvent>;

// Assume any event we receive over HTTP arrived via JSON, so no verifiedSymbol
// short-circuit. This helper enforces that in tests.
function overWire(e: SignedEvent): SignedEvent {
  return JSON.parse(JSON.stringify(e));
}

function makeBookmark(url = 'https://example.com/x'): { event: SignedEvent; pubkey: string } {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const event = finalizeEvent(
    {
      kind: 39701,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags: [
        ['d', url],
        ['title', 'Test'],
        ['description', 'desc'],
        ['t', 'bitcoin'],
        ['t', 'lightning'],
      ],
    },
    sk,
  );
  return { event, pubkey };
}

function makeDeletion(eventIdToDelete: string, sk?: Uint8Array): SignedEvent {
  const key = sk ?? generateSecretKey();
  return finalizeEvent(
    {
      kind: 5,
      created_at: Math.floor(Date.now() / 1000),
      content: 'deleted by author',
      tags: [['e', eventIdToDelete]],
    },
    key,
  );
}

/**
 * Mirrors the checks in POST /api/v1/bookmarks. Returns either
 * { ok: true } or { ok: false, status, error } so tests can pin each rule.
 */
function validatePublishRequest(
  event: SignedEvent,
  apiKeyOwnerPubkey: string,
): { ok: true } | { ok: false; status: number; error: string } {
  if (event.kind !== 39701) return { ok: false, status: 400, error: 'expected kind:39701 (public web bookmark)' };
  if (event.pubkey !== apiKeyOwnerPubkey) return { ok: false, status: 403, error: 'event pubkey does not match api key owner' };
  if (!verifyEvent(event)) return { ok: false, status: 400, error: 'event signature does not verify' };
  const hasDtag = event.tags.some((t) => t[0] === 'd' && typeof t[1] === 'string' && t[1]);
  if (!hasDtag) return { ok: false, status: 400, error: 'kind:39701 requires a d-tag with the URL' };
  return { ok: true };
}

function validateDeleteRequest(
  event: SignedEvent,
  apiKeyOwnerPubkey: string,
  routeEventId: string,
): { ok: true } | { ok: false; status: number; error: string } {
  if (event.kind !== 5) return { ok: false, status: 400, error: 'expected kind:5 deletion event' };
  if (event.pubkey !== apiKeyOwnerPubkey) return { ok: false, status: 403, error: 'event pubkey does not match api key owner' };
  if (!verifyEvent(event)) return { ok: false, status: 400, error: 'event signature does not verify' };
  const targetsMatch = event.tags.some((t) => t[0] === 'e' && t[1] === routeEventId);
  if (!targetsMatch) return { ok: false, status: 400, error: 'deletion event must have an e-tag matching the route parameter' };
  return { ok: true };
}

// ── POST /api/v1/bookmarks — publish rules ─────────────────────────────

describe('POST /api/v1/bookmarks — pre-signed event verification', () => {
  it('accepts a well-formed kind:39701 signed by the api-key owner', () => {
    const { event, pubkey } = makeBookmark();
    expect(validatePublishRequest(overWire(event), pubkey)).toEqual({ ok: true });
  });

  it('rejects events of the wrong kind (401 kind:1 text notes, say)', () => {
    const { event, pubkey } = makeBookmark();
    const note = { ...overWire(event), kind: 1 } as SignedEvent;
    const result = validatePublishRequest(note, pubkey);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('rejects when event.pubkey does not match the authenticated api-key owner', () => {
    const { event } = makeBookmark();
    const someoneElse = getPublicKey(generateSecretKey());
    const result = validatePublishRequest(overWire(event), someoneElse);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toMatch(/does not match/);
    }
  });

  it('rejects events whose signature does not verify', () => {
    const { event, pubkey } = makeBookmark();
    const wire = overWire(event);
    wire.id = 'a'.repeat(64); // sig is over the original id — mismatch
    const result = validatePublishRequest(wire, pubkey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/signature/);
    }
  });

  it('rejects kind:39701 events missing the d-tag (NIP-B0 requires URL)', () => {
    const sk = generateSecretKey();
    const event = finalizeEvent(
      {
        kind: 39701,
        created_at: Math.floor(Date.now() / 1000),
        content: '',
        tags: [['title', 'no url here']],
      },
      sk,
    );
    const result = validatePublishRequest(overWire(event), getPublicKey(sk));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/d-tag/);
  });
});

// ── DELETE /api/v1/bookmarks/:eventId — deletion rules ─────────────────

describe('DELETE /api/v1/bookmarks/:eventId — pre-signed deletion verification', () => {
  it('accepts a kind:5 event whose e-tag matches the route id', () => {
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const deletion = makeDeletion('target-event-id', sk);
    expect(
      validateDeleteRequest(overWire(deletion), pubkey, 'target-event-id'),
    ).toEqual({ ok: true });
  });

  it('rejects non-deletion kinds', () => {
    const { event, pubkey } = makeBookmark();
    const result = validateDeleteRequest(overWire(event), pubkey, 'any');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/kind:5/);
  });

  it('rejects when the event is signed by a different pubkey', () => {
    const deletion = makeDeletion('target');
    const otherKey = getPublicKey(generateSecretKey());
    const result = validateDeleteRequest(overWire(deletion), otherKey, 'target');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('rejects when the e-tag does not match the route parameter', () => {
    const sk = generateSecretKey();
    const deletion = makeDeletion('different-target', sk);
    const result = validateDeleteRequest(overWire(deletion), getPublicKey(sk), 'expected-target');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/e-tag/);
  });
});

// ── bookmarkEventToJson — API response shape ───────────────────────────

describe('bookmarkEventToJson', () => {
  it('extracts NIP-B0 fields into a flat JSON-friendly shape', () => {
    const { event } = makeBookmark('https://example.com/foo');
    const json = bookmarkEventToJson(event);
    expect(json.url).toBe('https://example.com/foo');
    expect(json.title).toBe('Test');
    expect(json.description).toBe('desc');
    expect(json.tags).toEqual(['bitcoin', 'lightning']);
    expect(json.archivedForever).toBe(false);
    expect(json.id).toBe(event.id);
    expect(json.pubkey).toBe(event.pubkey);
  });

  it('surfaces archive-tier + blossom + wayback tags when present', () => {
    const sk = generateSecretKey();
    const event = finalizeEvent(
      {
        kind: 39701,
        created_at: 1_700_000_000,
        content: '',
        tags: [
          ['d', 'https://x'],
          ['title', 'X'],
          ['archive-tier', 'forever'],
          ['blossom', 'sha256-abc'],
          ['wayback', 'https://web.archive.org/'],
        ],
      },
      sk,
    );
    const json = bookmarkEventToJson(event);
    expect(json.archivedForever).toBe(true);
    expect(json.blossomHash).toBe('sha256-abc');
    expect(json.waybackUrl).toBe('https://web.archive.org/');
    expect(json.savedAt).toBe(1_700_000_000);
  });

  it('falls back to the URL as title when no title tag is set', () => {
    const sk = generateSecretKey();
    const event = finalizeEvent(
      { kind: 39701, created_at: 0, content: '', tags: [['d', 'https://x']] },
      sk,
    );
    expect(bookmarkEventToJson(event).title).toBe('https://x');
  });
});
