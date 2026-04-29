// NIP-51 sync for wrapped archive keys (Phase 2B).
//
// Phase 2A stored wrapped archive keys in chrome.storage.local — fast,
// private, but device-local. A user who archives privately on their
// laptop can't decrypt the same blob from their phone or from the
// web app.
//
// Phase 2B publishes a single replaceable kind:30003 set with
// d="deepmarks-archive-keys" whose `content` is a NIP-44 v2 encrypted
// JSON map of { blobHash: archiveKeyPlaintextBase64 }. Sender +
// recipient = the user's own pubkey. Anyone signed in as that pubkey
// (extension, web app, future native client) can fetch + decrypt the
// set and recover any per-archive AES key.
//
// Local cache (chrome.storage.local) stays as a fast-path lookup; it's
// transparently rebuilt from the relay set on cache miss.

import { finalizeEvent, nip44, type Event as NostrEvent } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';
import { sharedPool, extractFailReason, type PublishFailure } from './nostr.js';
import { getReadRelays, getWriteRelays } from './settings-store.js';

export const KIND_ARCHIVE_KEY_SET = 30003;
export const ARCHIVE_KEY_SET_NAME = 'deepmarks-archive-keys';

interface KeyMap {
  // blobHash → plaintext archive key (base64)
  [blobHash: string]: string;
}

function conversationKey(nsecHex: string, ownPubkey: string): Uint8Array {
  return nip44.v2.utils.getConversationKey(hexToBytes(nsecHex), ownPubkey);
}

function decryptKeyMap(event: NostrEvent | null, nsecHex: string, ownPubkey: string): KeyMap {
  if (!event) return {};
  // Strict ownership check — a relay or attacker that injected an
  // event from a different pubkey under the same d-tag would be
  // ignored here. NIP-51 sets are per-author parameterized so a
  // mismatched pubkey is by definition not ours.
  if (event.pubkey !== ownPubkey) return {};
  try {
    const ck = conversationKey(nsecHex, ownPubkey);
    const plaintext = nip44.v2.decrypt(event.content, ck);
    const parsed = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: KeyMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === 'string' && typeof v === 'string') result[k] = v;
    }
    return result;
  } catch {
    // Corrupt content / wrong key / bad JSON — treat as empty so the
    // caller can republish a fresh set instead of crashing.
    return {};
  }
}

async function fetchLatest(ownPubkey: string): Promise<NostrEvent | null> {
  const pool = sharedPool();
  const relays = await getReadRelays();
  const events = await pool.querySync(
    relays,
    {
      kinds: [KIND_ARCHIVE_KEY_SET],
      authors: [ownPubkey],
      '#d': [ARCHIVE_KEY_SET_NAME],
      limit: 1,
    },
    { maxWait: 4000 },
  ).catch(() => [] as NostrEvent[]);
  return events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
}

/** Fetch the user's archive-key map from the relay. Empty object when
 *  no set has been published yet (first time on this account). */
export async function fetchArchiveKeyMap(nsecHex: string, ownPubkey: string): Promise<KeyMap> {
  const latest = await fetchLatest(ownPubkey);
  return decryptKeyMap(latest, nsecHex, ownPubkey);
}

/**
 * Add (or overwrite) one entry in the archive-key set. Always does a
 * fetch → merge → publish round-trip so a recent edit from another
 * device isn't clobbered. Returns publish result so callers can show
 * relay-rejection errors.
 *
 * Idempotent: re-publishing the same map is a no-op from the relay's
 * perspective (replaceable event, same content → same id).
 */
export async function addArchiveKeyToSet(
  blobHash: string,
  archiveKeyBase64: string,
  nsecHex: string,
  ownPubkey: string,
): Promise<{ event: NostrEvent; ok: string[]; failed: PublishFailure[] }> {
  const pool = sharedPool();
  const writeRelays = await getWriteRelays();

  const current = await fetchArchiveKeyMap(nsecHex, ownPubkey);
  if (current[blobHash] === archiveKeyBase64) {
    // Already in the set — synthesize a no-op result so callers don't
    // have to special-case. We don't republish identical content.
    const ev = finalizeEvent(
      {
        kind: KIND_ARCHIVE_KEY_SET,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', ARCHIVE_KEY_SET_NAME]],
        content: '',
      },
      hexToBytes(nsecHex),
    );
    return { event: ev, ok: writeRelays, failed: [] };
  }
  const next: KeyMap = { ...current, [blobHash]: archiveKeyBase64 };

  const ck = conversationKey(nsecHex, ownPubkey);
  const ciphertext = nip44.v2.encrypt(JSON.stringify(next), ck);
  const event = finalizeEvent(
    {
      kind: KIND_ARCHIVE_KEY_SET,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', ARCHIVE_KEY_SET_NAME]],
      content: ciphertext,
    },
    hexToBytes(nsecHex),
  );

  const results = await Promise.allSettled(
    writeRelays.map((url) => withTimeout(pool.publish([url], event)[0]!, 8000, url)),
  );
  const ok: string[] = [];
  const failed: PublishFailure[] = [];
  results.forEach((r, i) => {
    const url = writeRelays[i]!;
    if (r.status === 'fulfilled') ok.push(url);
    else failed.push({ url, reason: extractFailReason(r.reason) });
  });
  return { event, ok, failed };
}

/**
 * Remove one entry from the user's NIP-51 archive-key set. Used by the
 * delete-archive flow so mirror copies of the (now-orphaned) ciphertext
 * remain mathematically unreadable — without the key in the set, no
 * device the user signs in to can decrypt the blob.
 *
 * No-op + best-effort publish when the entry isn't present. Returns
 * the publish result for relay-rejection surfacing.
 */
export async function removeArchiveKeyFromSet(
  blobHash: string,
  nsecHex: string,
  ownPubkey: string,
): Promise<{ event: NostrEvent; ok: string[]; failed: PublishFailure[]; removed: boolean }> {
  const pool = sharedPool();
  const writeRelays = await getWriteRelays();

  const current = await fetchArchiveKeyMap(nsecHex, ownPubkey);
  const removed = blobHash in current;
  const next: KeyMap = { ...current };
  delete next[blobHash];

  const ck = conversationKey(nsecHex, ownPubkey);
  const ciphertext = nip44.v2.encrypt(JSON.stringify(next), ck);
  const event = finalizeEvent(
    {
      kind: KIND_ARCHIVE_KEY_SET,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', ARCHIVE_KEY_SET_NAME]],
      content: ciphertext,
    },
    hexToBytes(nsecHex),
  );

  const results = await Promise.allSettled(
    writeRelays.map((url) => withTimeout(pool.publish([url], event)[0]!, 8000, url)),
  );
  const ok: string[] = [];
  const failed: PublishFailure[] = [];
  results.forEach((r, i) => {
    const url = writeRelays[i]!;
    if (r.status === 'fulfilled') ok.push(url);
    else failed.push({ url, reason: extractFailReason(r.reason) });
  });
  return { event, ok, failed, removed };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}
