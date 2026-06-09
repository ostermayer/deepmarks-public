// Regression guards for the most severe finding of the 2026-06 review
// (EXT-F1 / PRIV-F3): the extension's private-bookmark save does a
// fetch → decrypt → append → republish-complete-set cycle, but
//
//   • a failed/timed-out relay read is swallowed into an EMPTY set
//     (querySync(...).catch(() => [])), and
//   • a chunk that fails to decrypt is swallowed into an EMPTY set too,
//
// after which publishPrivateBookmark would publish a fresh complete version
// (dm-set-count=1) containing only the new bookmark — wiping the user's
// entire private library on every device, because readers prefer the newest
// complete version and the publish travels over HTTPS (/publish), which can
// succeed exactly when the websocket read path is broken.
//
// FIXED: read failures now propagate, decrypt failures abort the rewrite,
// and a last-known-count guard in chrome.storage refuses rewrites after a
// silent-empty fetch — these tests are permanent guards.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { finalizeEvent, getPublicKey, generateSecretKey, nip44 } from 'nostr-tools';
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

import { publishPrivateBookmark } from '@src/lib/private-bookmarks.js';
import type { Event as NostrEvent } from 'nostr-tools';

const sk = generateSecretKey();
const nsecHex = bytesToHex(sk);
const pubkey = getPublicKey(sk);
const conversationKey = nip44.v2.utils.getConversationKey(hexToBytes(nsecHex), pubkey);

const EXISTING_URL = 'https://existing.example.com/post';
const NEW_URL = 'https://new.example.com/page';

function encryptedChunk(entries: string[][][], key = conversationKey): NostrEvent {
  return finalizeEvent(
    {
      kind: 30003,
      created_at: 1_700_000_000,
      tags: [
        ['d', 'deepmarks-private'],
        ['dm-set-version', 'v-existing'],
        ['dm-set-count', '1'],
      ],
      content: nip44.v2.encrypt(JSON.stringify(entries), key),
    },
    sk,
  );
}

function decryptPublishedEntries(event: NostrEvent): string[][][] {
  return JSON.parse(nip44.v2.decrypt(event.content, conversationKey));
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

describe('publishPrivateBookmark set-replacement safety', () => {
  it('appends to the existing set when the relay read succeeds (baseline)', async () => {
    querySync.mockResolvedValue([
      encryptedChunk([[['d', EXISTING_URL], ['title', 'existing']]]),
    ]);

    await publishPrivateBookmark({ url: NEW_URL, title: 'new', tags: [] }, nsecHex, pubkey);

    const published = postSignedEvent.mock.calls.map((call) => call[0] as NostrEvent);
    expect(published.length).toBeGreaterThan(0);
    const allEntries = published.flatMap(decryptPublishedEntries);
    const urls = allEntries.map((entry) => entry.find((t) => t[0] === 'd')?.[1]);
    expect(urls).toContain(EXISTING_URL);
    expect(urls).toContain(NEW_URL);
    // Wire format the web app's reader requires to pick this version.
    expect(published[0]!.tags.some((t) => t[0] === 'dm-set-version')).toBe(true);
    expect(published[0]!.tags.some((t) => t[0] === 'dm-set-count')).toBe(true);
  });

  // A querySync failure must refuse the whole-set rewrite — swallowing it
  // into an empty set published a complete 1-entry replacement, wiping
  // the private library relay-wide.
  it('refuses to publish a replacement set when the relay read failed', async () => {
    querySync.mockRejectedValue(new Error('relay read timed out'));

    await expect(
      publishPrivateBookmark({ url: NEW_URL, title: 'new', tags: [] }, nsecHex, pubkey),
    ).rejects.toThrow();
  });

  // Same wipe vector when the chunk exists but cannot be decrypted
  // (corrupt payload, key mismatch) — the rewrite must abort instead of
  // proceeding on top of entries: [].
  it('refuses to rebuild the set on top of an undecryptable chunk', async () => {
    const foreignKey = nip44.v2.utils.getConversationKey(generateSecretKey(), pubkey);
    querySync.mockResolvedValue([
      encryptedChunk([[['d', EXISTING_URL], ['title', 'existing']]], foreignKey),
    ]);

    await expect(
      publishPrivateBookmark({ url: NEW_URL, title: 'new', tags: [] }, nsecHex, pubkey),
    ).rejects.toThrow();
  });
});
