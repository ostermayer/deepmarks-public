import { describe, it, expect, vi } from 'vitest';
import type { SimplePool, Event as NostrEvent } from 'nostr-tools';
import { publishToRelays, queryRelaysWithTimeout, SignedEventSchema } from './api-helpers.js';

// ── SignedEventSchema — the first line of defense on every publish ─────

describe('SignedEventSchema', () => {
  const valid = {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1_700_000_000,
    kind: 39701,
    tags: [['d', 'https://x']],
    content: '',
    sig: 'c'.repeat(128),
  };
  it('accepts a well-formed event', () => {
    expect(SignedEventSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects an id that isn\'t 64 hex chars', () => {
    const bad = { ...valid, id: 'short' };
    expect(SignedEventSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects a sig that isn\'t 128 hex chars', () => {
    const bad = { ...valid, sig: 'short' };
    expect(SignedEventSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects negative created_at', () => {
    const bad = { ...valid, created_at: -1 };
    expect(SignedEventSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects non-string tag cells', () => {
    const bad = { ...valid, tags: [['d', 42 as unknown as string]] };
    expect(SignedEventSchema.safeParse(bad).success).toBe(false);
  });
});

// ── publishToRelays — one successful, one failing, one timing out ──────

function mockPool(results: (() => Promise<unknown>)[]): SimplePool {
  return {
    publish: () => results.map((r) => r()),
  } as unknown as SimplePool;
}

const dummyEvent: NostrEvent = {
  id: 'x'.repeat(64),
  pubkey: 'y'.repeat(64),
  created_at: 1_700_000_000,
  kind: 1,
  tags: [],
  content: '',
  sig: 'z'.repeat(128),
};

describe('publishToRelays', () => {
  it('reports all relays that accepted the event in `ok`', async () => {
    const pool = mockPool([
      () => Promise.resolve('ok'),
      () => Promise.resolve('ok'),
    ]);
    const { ok, failed } = await publishToRelays(
      pool,
      ['wss://a', 'wss://b'],
      dummyEvent,
      500,
    );
    expect(ok).toEqual(['wss://a', 'wss://b']);
    expect(failed).toEqual([]);
  });

  it('splits ok vs failed on per-relay basis', async () => {
    const pool = mockPool([
      () => Promise.resolve('ok'),
      () => Promise.reject(new Error('relay down')),
    ]);
    const { ok, failed } = await publishToRelays(
      pool,
      ['wss://a', 'wss://b'],
      dummyEvent,
      500,
    );
    expect(ok).toEqual(['wss://a']);
    expect(failed).toEqual(['wss://b']);
  });

  it('resolves within the timeout even if no relay responds', async () => {
    // Promises that never settle simulate a wedged relay.
    const pool = mockPool([
      () => new Promise(() => { /* never resolves */ }),
    ]);
    const start = Date.now();
    const { ok, failed } = await publishToRelays(pool, ['wss://stuck'], dummyEvent, 50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500); // wasn't blocked on the wedged promise
    // Neither ok nor failed populated when timeout wins.
    expect(ok.length + failed.length).toBe(0);
  });
});

// ── queryRelaysWithTimeout — event delivery + EOSE + timeout paths ─────

/**
 * Mock SimplePool that delivers a scripted set of events to the subscriber's
 * `onevent` then calls `oneose`. Optionally delays before either happens.
 */
function mockPoolWithEvents(events: NostrEvent[], opts: {
  eoseAfterMs?: number;
  eventDelayMs?: number;
} = {}): SimplePool {
  return {
    subscribeMany: (
      _relays: string[],
      _filter: unknown,
      handlers: { onevent?: (e: NostrEvent) => void; oneose?: () => void },
    ) => {
      setTimeout(() => {
        for (const e of events) handlers.onevent?.(e);
      }, opts.eventDelayMs ?? 0);
      if (opts.eoseAfterMs !== undefined) {
        setTimeout(() => handlers.oneose?.(), opts.eoseAfterMs);
      }
      return { close: vi.fn() };
    },
  } as unknown as SimplePool;
}

describe('queryRelaysWithTimeout', () => {
  it('resolves with every delivered event once the subscription sees EOSE', async () => {
    const a: NostrEvent = { ...dummyEvent, id: 'a'.repeat(64) };
    const b: NostrEvent = { ...dummyEvent, id: 'b'.repeat(64) };
    const pool = mockPoolWithEvents([a, b], { eoseAfterMs: 5 });
    const out = await queryRelaysWithTimeout(pool, ['wss://x'], {}, 500);
    expect(out.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('resolves at the timeout even if EOSE never arrives', async () => {
    const pool = mockPoolWithEvents([dummyEvent], { eventDelayMs: 0 });
    const start = Date.now();
    const out = await queryRelaysWithTimeout(pool, ['wss://x'], {}, 40);
    const elapsed = Date.now() - start;
    expect(out).toContainEqual(dummyEvent);
    expect(elapsed).toBeLessThan(500);
  });

  it('returns an empty array when no events + no EOSE within the budget', async () => {
    const pool = mockPoolWithEvents([], {});
    const out = await queryRelaysWithTimeout(pool, ['wss://x'], {}, 20);
    expect(out).toEqual([]);
  });
});
