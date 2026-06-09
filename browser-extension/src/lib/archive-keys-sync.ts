// NIP-51 sync for wrapped archive keys.
//
// The authoritative cross-device store is a kind:30003 parameterized
// replaceable set:
//   d="deepmarks-archive-keys"
//   content=NIP-44 encrypted JSON map { blobHash|job:<jobId>: archiveKeyBase64 }
//
// Large accounts exceed NIP-44's plaintext limit, so the set is chunked:
//   deepmarks-archive-keys
//   deepmarks-archive-keys-1
//   deepmarks-archive-keys-2
// Each chunk carries the same dm-set-version and dm-set-count tags.
// This mirrors frontend/src/lib/nostr/archive-keys.ts so extension
// writes never clobber keys published by the web/mobile app.

import { finalizeEvent, nip44, type Event as NostrEvent } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';
import { postSignedEvent, sharedPool, type PublishFailure } from './nostr.js';
import { getReadRelays, getWriteRelays } from './settings-store.js';

export const KIND_ARCHIVE_KEY_SET = 30003;
export const ARCHIVE_KEY_SET_NAME = 'deepmarks-archive-keys';

const SET_VERSION_TAG = 'dm-set-version';
const SET_COUNT_TAG = 'dm-set-count';
const MAX_CHUNK_PLAINTEXT_BYTES = 50_000;

interface KeyMap {
  [blobHashOrJobKey: string]: string;
}

interface PublishArchiveKeyMapResult {
  event: NostrEvent;
  ok: string[];
  failed: PublishFailure[];
}

function archiveKeyChunkName(idx: number): string {
  return idx === 0 ? ARCHIVE_KEY_SET_NAME : `${ARCHIVE_KEY_SET_NAME}-${idx}`;
}

export function archiveKeyJobMapKey(jobId: string | null | undefined): string | null {
  return jobId ? `job:${jobId}` : null;
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
  return tags.find((tag) => tag[0] === name)?.[1];
}

function conversationKey(nsecHex: string, ownPubkey: string): Uint8Array {
  return nip44.v2.utils.getConversationKey(hexToBytes(nsecHex), ownPubkey);
}

function decryptKeyMapChunk(event: NostrEvent | null, nsecHex: string, ownPubkey: string): KeyMap {
  if (!event || event.pubkey !== ownPubkey) return {};
  try {
    const ck = conversationKey(nsecHex, ownPubkey);
    const plaintext = nip44.v2.decrypt(event.content, ck);
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: KeyMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string') result[k] = v;
    }
    return result;
  } catch {
    return {};
  }
}

async function fetchLatestChunks(ownPubkey: string): Promise<NostrEvent[]> {
  const pool = sharedPool();
  const relays = await getReadRelays();
  const chunkZeroEvents = await pool.querySync(
    relays,
    {
      kinds: [KIND_ARCHIVE_KEY_SET],
      authors: [ownPubkey],
      '#d': [ARCHIVE_KEY_SET_NAME],
      limit: 10,
    },
    { maxWait: 4000 },
  ).catch(() => [] as NostrEvent[]);

  const chunkZero = chunkZeroEvents
    .filter((event) => event.pubkey === ownPubkey)
    .sort((a, b) => b.created_at - a.created_at)[0] ?? null;
  if (!chunkZero) return [];

  const setCount = Number(tagValue(chunkZero.tags, SET_COUNT_TAG) ?? 1);
  const setVersion = tagValue(chunkZero.tags, SET_VERSION_TAG);
  if (!Number.isInteger(setCount) || setCount <= 1) return [chunkZero];

  const extraDTags = Array.from({ length: setCount - 1 }, (_, i) => archiveKeyChunkName(i + 1));
  const extraEvents = await pool.querySync(
    relays,
    {
      kinds: [KIND_ARCHIVE_KEY_SET],
      authors: [ownPubkey],
      '#d': extraDTags,
      limit: Math.max(20, extraDTags.length * 4),
    },
    { maxWait: 5000 },
  ).catch(() => [] as NostrEvent[]);

  const byIndex = new Map<number, NostrEvent>([[0, chunkZero]]);
  for (const event of extraEvents) {
    if (event.pubkey !== ownPubkey) continue;
    if (setVersion && tagValue(event.tags, SET_VERSION_TAG) !== setVersion) continue;
    const index = parseArchiveKeyChunkIndex(tagValue(event.tags, 'd'));
    if (index === null || index <= 0 || index >= setCount) continue;
    const previous = byIndex.get(index);
    if (!previous || event.created_at > previous.created_at) byIndex.set(index, event);
  }

  return Array.from({ length: setCount }, (_, i) => byIndex.get(i)).filter(Boolean) as NostrEvent[];
}

/** Fetch the user's archive-key map from relays. Empty object when no
 * set has been published yet or the signer cannot decrypt it. */
export async function fetchArchiveKeyMap(nsecHex: string, ownPubkey: string): Promise<KeyMap> {
  const chunks = await fetchLatestChunks(ownPubkey);
  const merged: KeyMap = {};
  for (const chunk of chunks) {
    Object.assign(merged, decryptKeyMapChunk(chunk, nsecHex, ownPubkey));
  }
  return merged;
}

export async function addArchiveKeyToSet(
  blobHash: string,
  archiveKeyBase64: string,
  nsecHex: string,
  ownPubkey: string,
): Promise<PublishArchiveKeyMapResult> {
  const current = await fetchArchiveKeyMap(nsecHex, ownPubkey);
  if (current[blobHash] === archiveKeyBase64) {
    const relays = await getWriteRelays();
    const ev = finalizeEvent(
      {
        kind: KIND_ARCHIVE_KEY_SET,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', ARCHIVE_KEY_SET_NAME]],
        content: '',
      },
      hexToBytes(nsecHex),
    );
    return { event: ev, ok: relays, failed: [] };
  }
  return publishArchiveKeyMap({ ...current, [blobHash]: archiveKeyBase64 }, nsecHex, ownPubkey);
}

export async function removeArchiveKeyFromSet(
  blobHash: string,
  nsecHex: string,
  ownPubkey: string,
): Promise<PublishArchiveKeyMapResult & { removed: boolean }> {
  const current = await fetchArchiveKeyMap(nsecHex, ownPubkey);
  const removed = blobHash in current;
  const next: KeyMap = { ...current };
  delete next[blobHash];
  const result = await publishArchiveKeyMap(next, nsecHex, ownPubkey);
  return { ...result, removed };
}

function chunkArchiveKeyMap(map: KeyMap): KeyMap[] {
  const chunks: KeyMap[] = [{}];
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

async function publishArchiveKeyMap(
  map: KeyMap,
  nsecHex: string,
  ownPubkey: string,
): Promise<PublishArchiveKeyMapResult> {
  const writeRelays = await getWriteRelays();
  const ck = conversationKey(nsecHex, ownPubkey);
  const chunks = chunkArchiveKeyMap(map);
  const version = newArchiveKeyVersion();
  const createdAt = Math.floor(Date.now() / 1000);
  const ok = new Set<string>();
  const failed: PublishFailure[] = [];
  let firstEvent: NostrEvent | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const tags = [['d', archiveKeyChunkName(i)]];
    if (chunks.length > 1) {
      tags.push([SET_VERSION_TAG, version], [SET_COUNT_TAG, String(chunks.length)]);
    }
    const event = finalizeEvent(
      {
        kind: KIND_ARCHIVE_KEY_SET,
        created_at: createdAt + (chunks.length - i - 1),
        tags,
        content: nip44.v2.encrypt(JSON.stringify(chunks[i]!), ck),
      },
      hexToBytes(nsecHex),
    );
    if (i === 0) firstEvent = event;
    const result = await postSignedEvent(event, nsecHex, { relays: writeRelays, pool: sharedPool() });
    for (const relay of result.ok) ok.add(relay);
    failed.push(...result.failed);
  }

  if (!firstEvent) {
    firstEvent = finalizeEvent(
      {
        kind: KIND_ARCHIVE_KEY_SET,
        created_at: createdAt,
        tags: [['d', ARCHIVE_KEY_SET_NAME]],
        content: nip44.v2.encrypt('{}', ck),
      },
      hexToBytes(nsecHex),
    );
  }
  return { event: firstEvent, ok: Array.from(ok), failed };
}

function newArchiveKeyVersion(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `v${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
