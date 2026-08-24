import { describe, expect, it, vi } from 'vitest';
import type { Event as NostrEvent, SimplePool } from 'nostr-tools';
import { parseRelayMessage, subscribeSingleRelay } from '@src/relay-helpers.js';

describe('parseRelayMessage', () => {
  it('ignores malformed relay frames and returns valid events', () => {
    const subId = 'sub-1';
    const event: NostrEvent = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: 1,
      kind: 39701,
      tags: [],
      content: '',
      sig: 'c'.repeat(128),
    };

    expect(parseRelayMessage(Buffer.from([0, 1, 2, 3]), subId)).toBeNull();
    expect(parseRelayMessage(Buffer.from('{not json'), subId)).toBeNull();
    expect(parseRelayMessage(JSON.stringify(['EVENT', 'other', event]), subId)).toBeNull();
    expect(parseRelayMessage(JSON.stringify(['EVENT', subId, { kind: 39701 }]), subId)).toBeNull();
    expect(parseRelayMessage(JSON.stringify(['EVENT', subId, event]), subId)).toEqual({
      type: 'event',
      event,
    });
    expect(parseRelayMessage(JSON.stringify(['EOSE', subId]), subId)).toEqual({ type: 'done' });
    expect(parseRelayMessage(JSON.stringify(['CLOSED', subId, 'blocked']), subId)).toEqual({ type: 'done' });
  });
});

describe('subscribeSingleRelay', () => {
  // Regression for the 2026-07-27 relay-sync heap OOM: the workers'
  // lifetime strfry subscriptions must go through relay.subscribe (no
  // per-subscription id dedup Set), not SimplePool.subscribeMany.
  it('subscribes at the relay level and closes through to the relay sub', async () => {
    const relaySub = { close: vi.fn() };
    const subscribe = vi.fn().mockReturnValue(relaySub);
    const pool = {
      ensureRelay: vi.fn().mockResolvedValue({ subscribe }),
    } as unknown as SimplePool;
    const onevent = vi.fn();

    const handle = subscribeSingleRelay(pool, 'ws://strfry:7777', [{ kinds: [3] }], { onevent });
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());

    expect(pool.ensureRelay).toHaveBeenCalledWith('ws://strfry:7777');
    expect(subscribe).toHaveBeenCalledWith([{ kinds: [3] }], { onevent });
    handle.close();
    expect(relaySub.close).toHaveBeenCalledOnce();
  });

  it('retries until the relay accepts instead of giving up on one failure', async () => {
    const relaySub = { close: vi.fn() };
    const subscribe = vi.fn().mockReturnValue(relaySub);
    const ensureRelay = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue({ subscribe });
    const pool = { ensureRelay } as unknown as SimplePool;
    const logError = vi.fn();

    subscribeSingleRelay(pool, 'ws://strfry:7777', [{ kinds: [0] }], { onevent: vi.fn() }, {
      retryDelayMs: 1,
      logError,
    });
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());

    expect(ensureRelay).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledOnce();
  });

  it('does not open a subscription when closed before the relay connects', async () => {
    let resolveRelay!: (relay: unknown) => void;
    const subscribe = vi.fn();
    const pool = {
      ensureRelay: vi.fn().mockReturnValue(new Promise((resolve) => { resolveRelay = resolve; })),
    } as unknown as SimplePool;

    const handle = subscribeSingleRelay(pool, 'ws://strfry:7777', [{ kinds: [0] }], { onevent: vi.fn() });
    handle.close();
    resolveRelay({ subscribe });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(subscribe).not.toHaveBeenCalled();
  });
});
