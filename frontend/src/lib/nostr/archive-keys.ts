// Frontend reader for the user's NIP-51 archive-key set (Phase 2B).
//
// Mirrors browser-extension/src/lib/archive-keys-sync.ts: kind:30003
// with d="deepmarks-archive-keys", content = NIP-44 v2 encrypted JSON
// map of { blobHash: archiveKeyPlaintextBase64 }. Encrypted to self —
// sender + recipient = the user's own pubkey.
//
// Decryption goes through the NDK signer so this works equally well
// for nsec, NIP-07, and (eventually) NIP-46 sessions. AES-GCM blob
// decryption uses Web Crypto and matches archive-worker/src/crypto.ts:
// [12-byte nonce] [ciphertext] [16-byte GCM tag].

import { getNdk } from './ndk.js';

const KIND_ARCHIVE_KEY_SET = 30003;
const ARCHIVE_KEY_SET_NAME = 'deepmarks-archive-keys';

export interface ArchiveKeyMap {
  [blobHash: string]: string;
}

let cached: { pubkey: string; map: ArchiveKeyMap } | null = null;

/**
 * Fetch + decrypt the user's archive-key map. Cached in-module for the
 * page lifetime so the archives list doesn't refetch per-row. Pass
 * `force: true` to bypass the cache after a save (extension publishes
 * an update).
 */
export async function getArchiveKeyMap(
  ownPubkey: string,
  opts: { force?: boolean } = {},
): Promise<ArchiveKeyMap> {
  if (!opts.force && cached?.pubkey === ownPubkey) return cached.map;
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('no signer connected — sign in to view private archives');

  const event = await ndk.fetchEvent({
    kinds: [KIND_ARCHIVE_KEY_SET],
    authors: [ownPubkey],
    '#d': [ARCHIVE_KEY_SET_NAME],
  });
  if (!event) {
    cached = { pubkey: ownPubkey, map: {} };
    return {};
  }
  // Strict ownership check — relays returning an event from another
  // pubkey under the same d-tag would be ignored. Replaceable
  // parameterized events are per-author so a foreign pubkey here is
  // by definition not ours.
  if (event.pubkey !== ownPubkey) {
    cached = { pubkey: ownPubkey, map: {} };
    return {};
  }

  let plaintext: string;
  try {
    const me = ndk.getUser({ pubkey: ownPubkey });
    plaintext = await ndk.signer.decrypt(me, event.content, 'nip44');
  } catch {
    // Wrong key, corrupt content, signer-rejected — treat as empty
    // rather than throwing so the page renders with a useful error
    // per-row instead of an opaque page-level crash.
    cached = { pubkey: ownPubkey, map: {} };
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    cached = { pubkey: ownPubkey, map: {} };
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    cached = { pubkey: ownPubkey, map: {} };
    return {};
  }
  const map: ArchiveKeyMap = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof k === 'string' && typeof v === 'string') map[k] = v;
  }
  cached = { pubkey: ownPubkey, map };
  return map;
}

/** Drop the in-module cache. Test-only entry point + manual reload hook. */
export function invalidateArchiveKeyMap(): void {
  cached = null;
}

/**
 * AES-256-GCM decrypt of a blob fetched from Blossom. Layout matches
 * the worker's encryptBlob: [12-byte nonce] [ciphertext] [16-byte tag].
 * Web Crypto wants the tag appended, which is the same wire shape the
 * worker emits — no re-slicing needed.
 */
export async function decryptArchiveBlob(
  ciphertext: Uint8Array,
  archiveKeyBase64: string,
): Promise<Uint8Array> {
  if (ciphertext.byteLength < 28) {
    throw new Error('archive ciphertext too short');
  }
  const nonce = ciphertext.slice(0, 12);
  const body = ciphertext.slice(12);
  const keyBin = atob(archiveKeyBase64);
  const keyBytes = new Uint8Array(keyBin.length);
  for (let i = 0; i < keyBin.length; i++) keyBytes[i] = keyBin.charCodeAt(i);
  if (keyBytes.byteLength !== 32) {
    throw new Error(`archive key must be 32 bytes, got ${keyBytes.byteLength}`);
  }
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    key,
    body as BufferSource,
  );
  return new Uint8Array(plaintext);
}
