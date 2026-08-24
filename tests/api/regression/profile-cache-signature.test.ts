// Regression: the follows-ingester fetched kind:0 profiles from curators'
// external relays over a raw WebSocket (no signature check) and cached them
// keyed by the event's own pubkey. A hostile relay could return a forged
// kind:0 for an arbitrary victim with an attacker-chosen name/nip05/lud16,
// poisoning /profile/:pubkey and redirecting manual zaps. cacheProfileEvent
// now re-verifies at the sink.

import { describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';

import { cacheProfileEvent } from '@src/workers/profile-resolver.js';

function fakeRedis() {
  const store = new Map<string, string>();
  const set = vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; });
  const get = vi.fn(async (k: string) => store.get(k) ?? null);
  const multiExec = vi.fn(async () => []);
  const multi = vi.fn(() => {
    const chain = {
      set: () => chain,
      del: () => chain,
      exec: multiExec,
    };
    return chain;
  });
  return { set, get, multi, store } as never;
}

function signedProfile() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const event = finalizeEvent(
    {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify({ name: 'alice', lud16: 'alice@example.com' }),
    },
    sk,
  );
  return { event, pk };
}

describe('cacheProfileEvent signature gate', () => {
  it('caches a validly-signed kind:0', async () => {
    const redis = fakeRedis();
    const { event, pk } = signedProfile();
    await cacheProfileEvent(redis, event);
    expect((redis as unknown as { set: ReturnType<typeof vi.fn> }).set)
      .toHaveBeenCalledWith(`dm:profile-event:${pk}`, expect.any(String), 'EX', expect.any(Number));
  });

  it('drops a forged kind:0 whose signature does not verify', async () => {
    const redis = fakeRedis();
    const { event } = signedProfile();
    // Re-point the event at a victim pubkey without re-signing: verifyEvent
    // must fail and nothing may be written. Build a fresh plain object (not a
    // spread) so nostr-tools' internal "already-verified" cache symbol is not
    // carried over — mirroring the real ingester path, where events arrive as
    // JSON.parse output with no such marker.
    const victim = getPublicKey(generateSecretKey());
    const forged = {
      id: event.id,
      pubkey: victim,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    };
    await cacheProfileEvent(redis, forged);
    expect((redis as unknown as { set: ReturnType<typeof vi.fn> }).set).not.toHaveBeenCalled();
    expect((redis as unknown as { multi: ReturnType<typeof vi.fn> }).multi).not.toHaveBeenCalled();
  });

  it('drops a non-profile kind even if well-formed', async () => {
    const redis = fakeRedis();
    const sk = generateSecretKey();
    const note = finalizeEvent(
      { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: '{"name":"x"}' },
      sk,
    );
    await cacheProfileEvent(redis, note);
    expect((redis as unknown as { set: ReturnType<typeof vi.fn> }).set).not.toHaveBeenCalled();
  });
});
