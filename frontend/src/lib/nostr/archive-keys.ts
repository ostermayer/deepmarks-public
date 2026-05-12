// Frontend reader + writer for the user's NIP-51 archive-key set
// (Phase 2B).
//
// Mirrors browser-extension/src/lib/archive-keys-sync.ts: kind:30003
// with d="deepmarks-archive-keys", content = NIP-44 v2 encrypted JSON
// map of { blobHash: archiveKeyPlaintextBase64 }. Encrypted to self —
// sender + recipient = the user's own pubkey.
//
// Encrypt / decrypt go through the NDK signer so this works equally
// well for nsec, NIP-07, and NIP-46 sessions (no raw nsec hex
// needed). AES-GCM blob decryption uses Web Crypto and matches
// archive-worker/src/crypto.ts: [12-byte nonce] [ciphertext]
// [16-byte GCM tag].
//
// The pending-key stash uses localStorage as a tab-survival fallback:
// we generate the AES key client-side before paying the invoice, so a
// tab close between "key sent to proxy" and "archive completes" would
// otherwise lose the key forever. On every visit to /app/archives we
// reconcile any stashed keys against completed jobs.

import { browser } from '$app/environment';
import { getNdk } from './ndk.js';
import { publishEvent } from './publish.js';

const KIND_ARCHIVE_KEY_SET = 30003;
const ARCHIVE_KEY_SET_NAME = 'deepmarks-archive-keys';
const PENDING_STORAGE_KEY = 'deepmarks-pending-archive-keys';

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

// ── Writer / sync ────────────────────────────────────────────────────

/** Generate a fresh 32-byte AES-256 key and return it as standard
 *  base64 — the exact wire format the proxy + worker validate against
 *  (`/^[A-Za-z0-9+/]{43}=?$/`). */
export function generateArchiveKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Add (or overwrite) one entry in the user's archive-key set. Always
 * does a fetch → merge → publish round-trip so an edit from another
 * device isn't clobbered.
 *
 * Reuses the in-module read cache, then invalidates it after publish so
 * the next read sees the new entry without a stale relay round-trip.
 *
 * Returns the relay list the publish was accepted by. Throws on
 * encryption / signer failure; relay-level rejection surfaces as an
 * empty `relays` array.
 */
export async function addArchiveKeyToSet(
  blobHash: string,
  archiveKeyBase64: string,
  ownPubkey: string,
): Promise<{ eventId: string; relays: string[] }> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('no signer connected — sign in to sync archive keys');

  const current = await getArchiveKeyMap(ownPubkey, { force: true });
  if (current[blobHash] === archiveKeyBase64) {
    // Already in the set — nothing to publish.
    return { eventId: '', relays: [] };
  }
  const next: ArchiveKeyMap = { ...current, [blobHash]: archiveKeyBase64 };

  const me = ndk.getUser({ pubkey: ownPubkey });
  const ciphertext = await ndk.signer.encrypt(me, JSON.stringify(next), 'nip44');

  const result = await publishEvent(
    {
      kind: KIND_ARCHIVE_KEY_SET,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', ARCHIVE_KEY_SET_NAME]],
      content: ciphertext,
    },
    ownPubkey,
  );
  // Drop the cache so the next read picks up the freshly-published entry.
  invalidateArchiveKeyMap();
  return result;
}

// ── Pending-key stash (tab-close survival) ───────────────────────────

interface PendingMap {
  // paymentHash → { archiveKey: base64, createdAt: unix-seconds }
  [paymentHash: string]: { archiveKey: string; createdAt: number };
}

function readPendingMap(): PendingMap {
  if (!browser) return {};
  try {
    const raw = localStorage.getItem(PENDING_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PendingMap) : {};
  } catch {
    return {};
  }
}

function writePendingMap(map: PendingMap): void {
  if (!browser) return;
  try {
    localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota / private mode — non-fatal; stash just won't survive reload.
  }
}

/** Stash a freshly-generated archive key under its paymentHash *before*
 *  we enqueue the archive. Survives tab close. Once the archive completes
 *  and we know the blobHash, reconcileArchiveKeys promotes this entry
 *  to a permanent NIP-51 set publish + clears the stash. Same
 *  sensitivity tier as the user's nsec — localStorage-only. */
export function stashPendingArchiveKey(paymentHash: string, archiveKey: string): void {
  const map = readPendingMap();
  map[paymentHash] = { archiveKey, createdAt: Math.floor(Date.now() / 1000) };
  writePendingMap(map);
}

/** Read (without removing) a stashed key. Returns null if missing. */
export function getPendingArchiveKey(paymentHash: string): string | null {
  return readPendingMap()[paymentHash]?.archiveKey ?? null;
}

/** Drop a stashed key once it's been promoted to the NIP-51 set. */
export function clearPendingArchiveKey(paymentHash: string): void {
  const map = readPendingMap();
  if (paymentHash in map) {
    delete map[paymentHash];
    writePendingMap(map);
  }
}

/** Walk a list of completed private archives and promote any pending
 *  keys to the NIP-51 set. Called from the archives list mount so a
 *  tab-close mid-archive self-heals on the user's next visit. Sweeps
 *  abandoned stashes (>14d old, no matching archive) to keep
 *  localStorage bounded. */
export async function reconcileArchiveKeys(
  archives: Array<{ jobId: string; blobHash: string; tier: string }>,
  ownPubkey: string,
): Promise<{ reconciled: number; abandoned: number }> {
  const pending = readPendingMap();
  if (Object.keys(pending).length === 0) return { reconciled: 0, abandoned: 0 };

  const next: PendingMap = { ...pending };
  let reconciled = 0;

  for (const archive of archives) {
    if (archive.tier !== 'private') continue;
    const stashed = pending[archive.jobId];
    if (!stashed) continue;
    try {
      await addArchiveKeyToSet(archive.blobHash, stashed.archiveKey, ownPubkey);
      delete next[archive.jobId];
      reconciled++;
    } catch {
      // Keep the stash for a future retry; relay hiccups shouldn't
      // permanently abandon the key.
    }
  }

  // Sweep stashes >14d old — almost certainly archives that the proxy
  // expired or refunded. Plaintext key is useless without the matching
  // ciphertext blob, so we bound the storage.
  let abandoned = 0;
  const TWO_WEEKS = 14 * 24 * 60 * 60;
  const cutoff = Math.floor(Date.now() / 1000) - TWO_WEEKS;
  for (const [paymentHash, entry] of Object.entries(next)) {
    if (entry.createdAt < cutoff) {
      delete next[paymentHash];
      abandoned++;
    }
  }

  if (reconciled > 0 || abandoned > 0) writePendingMap(next);
  return { reconciled, abandoned };
}
