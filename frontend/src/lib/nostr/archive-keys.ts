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
// otherwise lose the key forever. Whenever the account archive index
// refreshes we reconcile any stashed keys against completed jobs.

import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { getNdk } from './ndk.js';
import { publishEvent } from './publish.js';
import { canonicalRelaySet } from './canonical-relay-set.js';
import { getRelayList } from './relay-list.js';

const KIND_ARCHIVE_KEY_SET = 30003;
const ARCHIVE_KEY_SET_NAME = 'deepmarks-archive-keys';
const PENDING_STORAGE_KEY = 'deepmarks-pending-archive-keys';
const SET_VERSION_TAG = 'dm-set-version';
const SET_COUNT_TAG = 'dm-set-count';
// NIP-44 v2 plaintext cap is 65,535 bytes. Stay well below it so an
// extra entry merged into a chunk on a future save still encrypts.
const MAX_CHUNK_PLAINTEXT_BYTES = 50_000;

export interface ArchiveKeyMap {
  [blobHash: string]: string;
}

let cached: { pubkey: string; map: ArchiveKeyMap } | null = null;

function archiveKeyChunkName(idx: number): string {
  return idx === 0 ? ARCHIVE_KEY_SET_NAME : `${ARCHIVE_KEY_SET_NAME}-${idx}`;
}

function parseArchiveKeyChunkIndex(dTag: string | undefined): number | null {
  if (!dTag) return null;
  if (dTag === ARCHIVE_KEY_SET_NAME) return 0;
  const prefix = `${ARCHIVE_KEY_SET_NAME}-`;
  if (!dTag.startsWith(prefix)) return null;
  const n = Number(dTag.slice(prefix.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

/** Split a key map into JSON chunks each under MAX_CHUNK_PLAINTEXT_BYTES.
 *  Single-chunk maps still produce one chunk so the legacy code path
 *  (no version tag, no count tag) keeps working unchanged. */
function chunkArchiveKeyMap(map: ArchiveKeyMap): ArchiveKeyMap[] {
  const chunks: ArchiveKeyMap[] = [{}];
  let currentLen = 2; // {}
  const COMMA_AND_COLON_OVERHEAD = 4;
  for (const [k, v] of Object.entries(map)) {
    const entryLen = k.length + v.length + COMMA_AND_COLON_OVERHEAD + 2;
    if (currentLen + entryLen > MAX_CHUNK_PLAINTEXT_BYTES && currentLen > 2) {
      chunks.push({});
      currentLen = 2;
    }
    chunks[chunks.length - 1]![k] = v;
    currentLen += entryLen;
  }
  return chunks;
}

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

  // The archive-key set lives on relay.deepmarks.org (where the
  // browser extension / iOS app publishes it after seeding a new
  // key). NDK's outbox routing only queries the author's NIP-65
  // write relays — which usually doesn't include relay.deepmarks.org
  // — so the default fetchEvent would miss the set entirely. Pass an
  // explicit relay set covering relay.deepmarks.org + active + NIP-65.
  const relaySet = buildArchiveKeyRelaySet(ownPubkey);

  // Step 1: read chunk 0 (d=deepmarks-archive-keys) to learn the
  // chunk count + version. Users with <~600 keys still produce a
  // single chunk 0 with no count/version tags, identical to the
  // legacy single-event layout — so existing data keeps working.
  const chunkZero = await ndk.fetchEvent(
    {
      kinds: [KIND_ARCHIVE_KEY_SET],
      authors: [ownPubkey],
      '#d': [ARCHIVE_KEY_SET_NAME],
    },
    relaySet ? { groupable: false } : undefined,
    relaySet ?? undefined,
  );
  if (!chunkZero) {
    cached = { pubkey: ownPubkey, map: {} };
    return {};
  }
  if (chunkZero.pubkey !== ownPubkey) {
    cached = { pubkey: ownPubkey, map: {} };
    return {};
  }

  const setCount = Number(tagValue(chunkZero.tags, SET_COUNT_TAG) ?? 1);
  const setVersion = tagValue(chunkZero.tags, SET_VERSION_TAG);

  // Step 2: fetch remaining chunks (if any) in one filter. NIP-01
  // supports a multi-value `#d` filter, so a single round-trip
  // returns chunks 1..N-1.
  const allChunks: Array<{ tags: string[][]; content: string }> = [{
    tags: chunkZero.tags,
    content: chunkZero.content,
  }];
  if (setCount > 1) {
    const extraDTags = Array.from({ length: setCount - 1 }, (_, i) => archiveKeyChunkName(i + 1));
    const extra = await ndk.fetchEvents(
      {
        kinds: [KIND_ARCHIVE_KEY_SET],
        authors: [ownPubkey],
        '#d': extraDTags,
      },
      relaySet ? { groupable: false } : undefined,
      relaySet ?? undefined,
    );
    for (const event of extra) {
      if (event.pubkey !== ownPubkey) continue;
      // Mismatched-version chunks are stale from a previous write
      // session — skip so we don't merge keys from a half-written
      // generation.
      if (setVersion && tagValue(event.tags, SET_VERSION_TAG) !== setVersion) continue;
      allChunks.push({ tags: event.tags, content: event.content });
    }
  }

  // Step 3: decrypt + merge.
  const me = ndk.getUser({ pubkey: ownPubkey });
  const merged: ArchiveKeyMap = {};
  for (const chunk of allChunks) {
    let plaintext: string;
    try {
      plaintext = await ndk.signer.decrypt(me, chunk.content, 'nip44');
    } catch {
      // Skip this chunk — bad ciphertext or signer-rejected. Other
      // chunks still contribute their keys instead of nuking the
      // whole map.
      continue;
    }
    try {
      const parsed = JSON.parse(plaintext) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof k === 'string' && typeof v === 'string') merged[k] = v;
      }
    } catch { /* corrupt JSON in this chunk — skip */ }
  }

  cached = { pubkey: ownPubkey, map: merged };
  return merged;
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
  const result = await publishArchiveKeyMap(next, ownPubkey);
  invalidateArchiveKeyMap();
  return result;
}

/** Publish the entire archive-key map as one or more encrypted
 *  chunks. Required because NIP-44 plaintext is capped at ~65KB and
 *  power users accumulate enough archive keys (~600+) that a single
 *  blob silently fails to encrypt.
 *
 *  Returns the chunk-0 publish result so callers that previously
 *  spoke "one event per map" still get an eventId + relay set.
 *  Throws if chunk 0 fails to publish (data isn't durable without
 *  chunk 0's count tag); later-chunk failures get enqueued in the
 *  durable publish queue inside publishEvent and surface as a
 *  warning. */
async function publishArchiveKeyMap(
  map: ArchiveKeyMap,
  ownPubkey: string,
): Promise<{ eventId: string; relays: string[] }> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('no signer connected — sign in to sync archive keys');
  const me = ndk.getUser({ pubkey: ownPubkey });

  const chunks = chunkArchiveKeyMap(map);
  const version = newArchiveKeyVersion();
  const createdAt = Math.floor(Date.now() / 1000);

  let firstResult: { eventId: string; relays: string[] } | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const dTag = archiveKeyChunkName(i);
    const ciphertext = await ndk.signer.encrypt(me, JSON.stringify(chunks[i]!), 'nip44');
    const tags: string[][] = [['d', dTag]];
    // Only stamp version/count when chunking is actually in play.
    // Keeps the legacy single-chunk wire shape backwards-compatible
    // with the prior reader.
    if (chunks.length > 1) {
      tags.push([SET_VERSION_TAG, version], [SET_COUNT_TAG, String(chunks.length)]);
    }
    // created_at: stamp earlier chunks slightly later so the
    // primary (chunk 0) is the newest replaceable event for its
    // d-tag — gives us a stable "fetch chunk 0 first" entrypoint.
    const result = await publishEvent(
      {
        kind: KIND_ARCHIVE_KEY_SET,
        created_at: createdAt + (chunks.length - i - 1),
        tags,
        content: ciphertext,
      },
      ownPubkey,
    );
    if (i === 0) firstResult = result;
  }
  return firstResult ?? { eventId: '', relays: [] };
}

function newArchiveKeyVersion(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `v${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
  archives: Array<{ jobId: string; blobHash: string; tier: string; files?: Array<{ blobHash: string }> }>,
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
      for (const blobHash of archiveBlobHashes(archive)) {
        await addArchiveKeyToSet(blobHash, stashed.archiveKey, ownPubkey);
      }
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

function archiveBlobHashes(archive: { blobHash: string; files?: Array<{ blobHash: string }> }): string[] {
  const hashes = new Set<string>();
  if (archive.blobHash) hashes.add(archive.blobHash);
  for (const file of archive.files ?? []) {
    if (file.blobHash) hashes.add(file.blobHash);
  }
  return [...hashes];
}

function buildArchiveKeyRelaySet(ownPubkey: string) {
  // Pull NIP-65 advertised relays synchronously off the user's relay-list
  // store so the canonical set includes everything the user's events
  // could live on.
  const extra: string[] = [];
  try {
    const relayListStore = getRelayList(ownPubkey);
    const snapshot = relayListStore ? (get(relayListStore) as { relays?: { url: string }[] } | null) : null;
    if (snapshot?.relays) for (const r of snapshot.relays) extra.push(r.url);
  } catch { /* relay list not loaded yet — that's fine */ }
  return canonicalRelaySet(extra);
}
