// Regression guards for audit findings SYNC-F6 / PUB-F3 (2026-06 review),
// FIXED:
//
//   SYNC-F6  the durable queue replayed replaceable templates with their
//            original created_at — after any newer save of the same
//            d-tag the relay silently discarded the drained edit as
//            "older" while the drain reported success.
//   PUB-F3   offline tabs and signer-locked sessions burned the bounded
//            attempt budget every drain tick until queued saves silently
//            expired (30 attempts ≈ 45 minutes of a locked tab).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import {
  drainPendingPublishes,
  drainTemplate,
  enqueuePendingPublish,
  pendingPublishCount,
  setPendingPublishImpl,
} from '$lib/nostr/pending-publish.js';
import type { UnsignedEventTemplate } from '$lib/nostr/bookmarks.js';

const PUBKEY = 'a'.repeat(64);

function template(overrides: Partial<UnsignedEventTemplate> = {}): UnsignedEventTemplate {
  return {
    kind: 39701,
    created_at: 1_700_000_000, // far in the past
    tags: [['d', 'https://example.com/']],
    content: '',
    ...overrides,
  };
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setPendingPublishImpl(async () => ({ relays: ['wss://relay.deepmarks.org'] }));
});

describe('drainTemplate (SYNC-F6)', () => {
  it('re-stamps replaceable templates to drain time', () => {
    const stamped = drainTemplate(template());
    expect(stamped.created_at).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('always moves past the original timestamp even with a skewed clock', () => {
    const future = template({ created_at: Math.floor(Date.now() / 1000) + 10_000 });
    expect(drainTemplate(future).created_at).toBe(future.created_at + 1);
  });

  it('leaves non-replaceable events untouched (their id is their identity)', () => {
    const note = template({ kind: 1, tags: [] });
    expect(drainTemplate(note).created_at).toBe(note.created_at);
  });
});

describe('drain attempt budget (PUB-F3)', () => {
  it('publishes the re-stamped template, not the stale original', async () => {
    enqueuePendingPublish(template(), PUBKEY);
    const seen: number[] = [];
    setPendingPublishImpl(async (t) => {
      seen.push(t.created_at);
      return { relays: ['wss://relay.deepmarks.org'] };
    });

    const result = await drainPendingPublishes(PUBKEY);

    expect(result.ok).toBe(1);
    expect(seen[0]).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('does not burn an attempt when the signer is locked', async () => {
    enqueuePendingPublish(template(), PUBKEY);
    setPendingPublishImpl(async () => {
      throw new Error('No signer attached. Sign in first.');
    });

    await drainPendingPublishes(PUBKEY);
    await drainPendingPublishes(PUBKEY);

    const raw = JSON.parse(localStorage.getItem(`deepmarks-pending-publish:${PUBKEY}`)!);
    expect(raw[0].attempts).toBe(0); // still zero after two locked drains
    expect(pendingPublishCount(PUBKEY)).toBe(1);
  });

  it('still counts real publish failures against the budget', async () => {
    enqueuePendingPublish(template(), PUBKEY);
    setPendingPublishImpl(async () => {
      throw new Error('connection refused');
    });

    await drainPendingPublishes(PUBKEY);

    const raw = JSON.parse(localStorage.getItem(`deepmarks-pending-publish:${PUBKEY}`)!);
    expect(raw[0].attempts).toBe(1);
  });

  it('skips the drain entirely while offline', async () => {
    enqueuePendingPublish(template(), PUBKEY);
    vi.stubGlobal('navigator', { onLine: false });
    const impl = vi.fn(async () => ({ relays: ['wss://relay.deepmarks.org'] }));
    setPendingPublishImpl(impl);

    const result = await drainPendingPublishes(PUBKEY);

    expect(result).toEqual({ attempted: 0, ok: 0, failed: 0, remaining: 1 });
    expect(impl).not.toHaveBeenCalled();
  });
});
