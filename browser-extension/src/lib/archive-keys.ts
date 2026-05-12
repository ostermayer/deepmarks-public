// Per-archive key management for the private-archive flow.
//
// Two-tier storage:
//   • chrome.storage.local — fast on-device cache. Each entry is the
//     archive key wrapped with NIP-44 v2 self-encryption so a
//     compromised storage dump still requires the user's nsec to
//     unlock. Keyed by blobHash.
//   • NIP-51 set on Nostr (kind:30003, d="deepmarks-archive-keys") —
//     authoritative cross-device store. Content is a single
//     NIP-44-encrypted JSON map of { blobHash: plaintextKey }. Lets
//     the same user decrypt private archives from any signed-in
//     device or from the web app.
//
// On save we write to both. On read we hit local first; on miss we
// fall back to the relay set, decrypt the entry, and seed the local
// cache so subsequent reads stay fast.
//
// Encrypt-then-store ciphertext layout (worker-side):
//   [12-byte AES-GCM nonce] [ciphertext] [16-byte GCM tag]

import { nip44 } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';
import { addArchiveKeyToSet, fetchArchiveKeyMap, removeArchiveKeyFromSet } from './archive-keys-sync.js';

const STORAGE_KEY = 'deepmarks-archive-keys';
// Pre-completion stash: holds plaintext keys keyed by paymentHash
// from the moment we generate one until the worker finishes the
// archive and we know the blobHash. Without this, a popup that
// closes before the archive completes loses the key forever — the
// server zeros its in-memory copy after encrypting and the user
// can never decrypt the snapshot. Cleared via reconcileArchiveKeys
// on the next popup open after the archive ships.
const PENDING_STORAGE_KEY = 'deepmarks-pending-archive-keys';

interface KeyMap {
  // blobHash → base64 NIP-44 v2 ciphertext containing the AES key
  [blobHash: string]: string;
}

interface PendingMap {
  // paymentHash → plaintext archive key (base64). Plaintext rather
  // than wrapped because reconciliation needs to publish to the
  // user's NIP-51 set, which expects plaintext. The store survives
  // popup close + browser restart; entries are cleared as soon as
  // they're reconciled to a blobHash. Treat at the same sensitivity
  // tier as the user's nsec — chrome.storage.local-only, never logged.
  [paymentHash: string]: { archiveKey: string; createdAt: number };
}

/** Generate a fresh 32-byte AES-256 key and return it as standard
 *  base64 (the wire format the backend + worker expect). */
export function generateArchiveKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Wrap a plaintext archive key with NIP-44 v2 self-encryption so it
 *  can be safely persisted (in chrome.storage.local today, in a
 *  NIP-51 set later). Sender + recipient = ownPubkey. */
export function wrapArchiveKey(plaintextBase64: string, nsecHex: string, ownPubkey: string): string {
  const conversationKey = nip44.v2.utils.getConversationKey(hexToBytes(nsecHex), ownPubkey);
  return nip44.v2.encrypt(plaintextBase64, conversationKey);
}

/** Unwrap a previously-stored wrapped key. Throws on bad ciphertext /
 *  wrong nsec / corrupt blob — caller should treat any throw as
 *  "snapshot can't be decrypted" (likely lost the nsec). */
export function unwrapArchiveKey(wrapped: string, nsecHex: string, ownPubkey: string): string {
  const conversationKey = nip44.v2.utils.getConversationKey(hexToBytes(nsecHex), ownPubkey);
  return nip44.v2.decrypt(wrapped, conversationKey);
}

/** Persist a wrapped key under a blobHash. Idempotent — overwriting
 *  is safe since the underlying ciphertext blob is the same content
 *  (Blossom stores by hash, so same hash = same bytes). */
export async function saveWrappedKey(blobHash: string, wrappedKey: string): Promise<void> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const existing = (raw[STORAGE_KEY] as KeyMap | undefined) ?? {};
  existing[blobHash] = wrappedKey;
  await chrome.storage.local.set({ [STORAGE_KEY]: existing });
}

/** Fetch the wrapped key for a given blobHash from local cache only.
 *  Returns null on miss — for the cross-device path use getArchiveKey
 *  (which also consults the NIP-51 set on the relay). */
export async function getWrappedKey(blobHash: string): Promise<string | null> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const map = raw[STORAGE_KEY] as KeyMap | undefined;
  return map?.[blobHash] ?? null;
}

/**
 * Save a freshly-minted archive key locally AND publish it to the
 * user's NIP-51 set. Local write is synchronous-ish (chrome.storage),
 * relay publish is best-effort — a failed publish leaves the local
 * cache populated so the user can still decrypt on this device, and
 * the next save+sync attempt will eventually push the missing entry
 * (the addArchiveKeyToSet path always merges with the relay's
 * current state).
 *
 * Returns the publish result so callers can surface relay-rejection
 * warnings on the Saved screen. Throws only on local-storage failure.
 */
export async function saveArchiveKey(
  blobHash: string,
  archiveKeyBase64: string,
  nsecHex: string,
  ownPubkey: string,
): Promise<{ syncedToRelay: boolean; relayError?: string }> {
  const wrapped = wrapArchiveKey(archiveKeyBase64, nsecHex, ownPubkey);
  await saveWrappedKey(blobHash, wrapped);
  try {
    const result = await addArchiveKeyToSet(blobHash, archiveKeyBase64, nsecHex, ownPubkey);
    if (result.ok.length === 0) {
      return {
        syncedToRelay: false,
        relayError: result.failed[0]?.reason ?? 'no relay accepted the publish',
      };
    }
    return { syncedToRelay: true };
  } catch (err) {
    return { syncedToRelay: false, relayError: (err as Error).message };
  }
}

/**
 * Stash a freshly-minted archive key under its paymentHash *before*
 * we ship it to the server. Survives popup close. Once the archive
 * completes (status='archived' with a blobHash), reconcileArchiveKeys
 * promotes this entry to a permanent saveArchiveKey + clears the
 * stash. Plaintext key on chrome.storage.local — same sensitivity as
 * the user's nsec.
 */
export async function stashPendingKey(paymentHash: string, archiveKey: string): Promise<void> {
  const raw = await chrome.storage.local.get(PENDING_STORAGE_KEY);
  const existing = (raw[PENDING_STORAGE_KEY] as PendingMap | undefined) ?? {};
  existing[paymentHash] = { archiveKey, createdAt: Math.floor(Date.now() / 1000) };
  await chrome.storage.local.set({ [PENDING_STORAGE_KEY]: existing });
}

async function readPendingMap(): Promise<PendingMap> {
  const raw = await chrome.storage.local.get(PENDING_STORAGE_KEY);
  return (raw[PENDING_STORAGE_KEY] as PendingMap | undefined) ?? {};
}

async function writePendingMap(map: PendingMap): Promise<void> {
  await chrome.storage.local.set({ [PENDING_STORAGE_KEY]: map });
}

/**
 * Walk the user's archives and reconcile any pending keys (paymentHash
 * stashes from earlier saves) into permanent saveArchiveKey calls.
 * Called on every Recent screen mount so the popup self-heals after
 * a save→close→reopen cycle. Only touches archives whose paymentHash
 * matches a pending stash AND whose blobHash isn't already in the
 * local key map.
 *
 * Returns counts so the UI can surface "synced N archives" if useful.
 */
export async function reconcileArchiveKeys(
  archives: Array<{ jobId: string; blobHash: string; tier: string }>,
  nsecHex: string,
  ownPubkey: string,
): Promise<{ reconciled: number; abandoned: number }> {
  const pending = await readPendingMap();
  if (Object.keys(pending).length === 0) return { reconciled: 0, abandoned: 0 };

  let reconciled = 0;
  const next: PendingMap = { ...pending };
  for (const archive of archives) {
    if (archive.tier !== 'private') continue;
    const stashed = pending[archive.jobId];
    if (!stashed) continue;
    // Already keyed locally? Just clear the stash.
    const localWrapped = await getWrappedKey(archive.blobHash);
    if (localWrapped) {
      delete next[archive.jobId];
      continue;
    }
    try {
      await saveArchiveKey(archive.blobHash, stashed.archiveKey, nsecHex, ownPubkey);
      delete next[archive.jobId];
      reconciled++;
    } catch {
      // Keep the stash for a future retry; saveArchiveKey publishes
      // to NIP-51 and may transiently fail on relay hiccups.
    }
  }

  // Sweep stashes older than 14 days that never reconciled — likely
  // archives that the server expired or refunded. The plaintext key
  // is useless without the corresponding ciphertext blob, so we
  // bound the storage growth.
  let abandoned = 0;
  const TWO_WEEKS = 14 * 24 * 60 * 60;
  const cutoff = Math.floor(Date.now() / 1000) - TWO_WEEKS;
  for (const [paymentHash, entry] of Object.entries(next)) {
    if (entry.createdAt < cutoff) {
      delete next[paymentHash];
      abandoned++;
    }
  }

  if (reconciled > 0 || abandoned > 0) {
    await writePendingMap(next);
  }
  return { reconciled, abandoned };
}

/**
 * Companion to saveArchiveKey: drop the local cache entry AND publish
 * a NIP-51 set update without the entry. Used by the delete-archive
 * flow so mirror copies of the orphaned ciphertext stay unreadable
 * across all the user's devices. Best-effort relay step — a failure
 * still purges the local cache so this device can't decrypt.
 */
export async function purgeArchiveKey(
  blobHash: string,
  nsecHex: string,
  ownPubkey: string,
): Promise<{ syncedToRelay: boolean; relayError?: string }> {
  // Local first — guaranteed effect even if the relay step fails.
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEY);
    const existing = (raw[STORAGE_KEY] as KeyMap | undefined) ?? {};
    if (blobHash in existing) {
      delete existing[blobHash];
      await chrome.storage.local.set({ [STORAGE_KEY]: existing });
    }
  } catch {
    // Local write failed — continue to relay step.
  }
  try {
    const result = await removeArchiveKeyFromSet(blobHash, nsecHex, ownPubkey);
    if (result.ok.length === 0 && result.removed) {
      return {
        syncedToRelay: false,
        relayError: result.failed[0]?.reason ?? 'no relay accepted the publish',
      };
    }
    return { syncedToRelay: true };
  } catch (err) {
    return { syncedToRelay: false, relayError: (err as Error).message };
  }
}

/**
 * Resolve the plaintext archive key for a blobHash. Tries local cache
 * first; on miss, fetches the user's NIP-51 set, decrypts, looks up
 * the entry, and seeds the local cache so subsequent reads are fast.
 * Returns null when the key isn't anywhere — i.e., the archive was
 * made by a different account, or the user has lost their NIP-51 set
 * (e.g., rotated nsec without migrating).
 */
export async function getArchiveKey(
  blobHash: string,
  nsecHex: string,
  ownPubkey: string,
): Promise<string | null> {
  const localWrapped = await getWrappedKey(blobHash);
  if (localWrapped) {
    try {
      return unwrapArchiveKey(localWrapped, nsecHex, ownPubkey);
    } catch {
      // Local entry corrupted — fall through to the relay set so we
      // can recover.
    }
  }
  const map = await fetchArchiveKeyMap(nsecHex, ownPubkey);
  const plaintext = map[blobHash];
  if (!plaintext) return null;
  // Seed the local cache for next time. Wrap so at-rest storage is
  // still encrypted — same format as if the key had been saved on
  // this device originally.
  try {
    const wrapped = wrapArchiveKey(plaintext, nsecHex, ownPubkey);
    await saveWrappedKey(blobHash, wrapped);
  } catch {
    // Cache miss is recoverable; if the local write fails we still
    // return the plaintext so the user can view the archive now.
  }
  return plaintext;
}

/** Decrypt a ciphertext blob fetched from Blossom. The encrypted
 *  layout matches what archive-worker/src/crypto.ts:encryptBlob emits:
 *  [12-byte nonce] [ciphertext] [16-byte GCM tag]. Throws on AEAD
 *  tag mismatch (wrong key / corrupted bytes). */
export async function decryptArchiveBlob(
  ciphertext: Uint8Array,
  archiveKeyBase64: string,
): Promise<Uint8Array> {
  if (ciphertext.byteLength < 28) {
    throw new Error('archive ciphertext too short');
  }
  const nonce = ciphertext.slice(0, 12);
  const body = ciphertext.slice(12);  // includes the 16-byte tag at the end (Web Crypto wants it appended)
  // Decode base64 key.
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
