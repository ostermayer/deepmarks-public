// Regression guards for EXT-F1 / PRIV-F3 (2026-06 review) and the
// per-item migration that closed the whole class:
//
// History: the extension used to fetch → decrypt → append → republish
// the COMPLETE chunked private set on every save. A failed relay read
// (or undecryptable chunk) collapsed to an empty set, and the rewrite
// wiped the user's private library on every device. Round 1 added
// guards; the per-item migration removed the rewrite entirely — a save
// now publishes ONE replaceable event keyed by the URL hash
// (d=deepmarks-private-item:<sha256(url)>), and a delete publishes only
// its tombstone. These tests pin that a save/delete:
//   1. never reads the existing set (no fetch → nothing to corrupt),
//   2. never emits a chunk/set-replacement event (no dm-set-version),
//   3. emits exactly the per-item event the web app's reader merges.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSecretKey, getPublicKey, nip44, verifyEvent } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

const querySync = vi.fn();
const postSignedEvent = vi.fn();

vi.mock('@src/lib/nostr.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/lib/nostr.js')>();
  return {
    ...actual,
    sharedPool: () => ({ querySync }),
    postSignedEvent: (...args: unknown[]) => postSignedEvent(...args),
  };
});

vi.mock('@src/lib/settings-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/lib/settings-store.js')>();
  return {
    ...actual,
    getReadRelays: async () => ['wss://relay.deepmarks.org'],
    getWriteRelays: async () => ['wss://relay.deepmarks.org'],
  };
});

import { publishPrivateBookmark, deletePrivateBookmark } from '@src/lib/private-bookmarks.js';
import type { Event as NostrEvent } from 'nostr-tools';

const sk = generateSecretKey();
const nsecHex = bytesToHex(sk);
const pubkey = getPublicKey(sk);
const conversationKey = nip44.v2.utils.getConversationKey(hexToBytes(nsecHex), pubkey);

const NEW_URL = 'https://new.example.com/page';

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function publishedEvents(): NostrEvent[] {
  return postSignedEvent.mock.calls.map((call) => call[0] as NostrEvent);
}

beforeEach(() => {
  querySync.mockReset();
  postSignedEvent.mockReset();
  postSignedEvent.mockImplementation(async (event: NostrEvent) => ({
    ok: ['wss://relay.deepmarks.org'],
    failed: [],
    event,
  }));
});

describe('per-item private saves (wipe class eliminated)', () => {
  it('publishes exactly one per-item event and never reads the existing set', async () => {
    querySync.mockRejectedValue(new Error('relay read would have failed — must not matter'));

    await publishPrivateBookmark({ url: NEW_URL, title: 'new', tags: ['t1'] }, nsecHex, pubkey);

    expect(querySync).not.toHaveBeenCalled();
    const events = publishedEvents();
    expect(events).toHaveLength(1);

    const event = events[0]!;
    expect(event.tags.find((t) => t[0] === 'd')?.[1])
      .toBe(`deepmarks-private-item:${await sha256Hex(NEW_URL)}`);
    // No set-replacement markers — this is not a chunk rewrite.
    expect(event.tags.some((t) => t[0] === 'dm-set-version')).toBe(false);
    expect(verifyEvent(event)).toBe(true);

    const entries = JSON.parse(nip44.v2.decrypt(event.content, conversationKey)) as string[][][];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.find((t) => t[0] === 'd')?.[1]).toBe(NEW_URL);
    expect(entries[0]!.find((t) => t[0] === 't')?.[1]).toBe('t1');
  });

  it('delete publishes only the tombstone item', async () => {
    const result = await deletePrivateBookmark(NEW_URL, nsecHex, pubkey);

    expect(querySync).not.toHaveBeenCalled();
    const events = publishedEvents();
    expect(events).toHaveLength(1);
    expect(result.removed).toBe(true);

    const entries = JSON.parse(nip44.v2.decrypt(events[0]!.content, conversationKey)) as string[][][];
    expect(entries[0]).toEqual([['d', NEW_URL], ['deleted', '1']]);
  });
});
