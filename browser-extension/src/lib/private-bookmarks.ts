// NIP-51 private bookmark set — kind:30003, NIP-44 v2 encrypted to self.
//
// Mirrors frontend/src/lib/nostr/private-bookmarks.ts in shape so a
// bookmark saved privately from the extension shows up in the web
// app's private feed unchanged. The `d` tag is the set name —
// "deepmarks-private" by convention — and the `content` is the JSON
// of an array-of-tag-arrays, encrypted to the user's own pubkey.

import { finalizeEvent, nip44, type Event as NostrEvent } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';
import { sharedPool, extractFailReason, type PublishFailure } from './nostr.js';
import { getReadRelays, getWriteRelays } from './settings-store.js';
import { buildBookmarkTemplate, type BookmarkInput, KIND_BOOKMARK } from './nostr.js';

export const KIND_PRIVATE_SET = 30003;
export const PRIVATE_SET_NAME = 'deepmarks-private';
const PRIVATE_SET_CHUNK_PREFIX = `${PRIVATE_SET_NAME}-`;
const MAX_PRIVATE_SET_PLAINTEXT_BYTES = 60_000;
const SET_VERSION_TAG = 'dm-set-version';
const SET_COUNT_TAG = 'dm-set-count';

/** Inner tag arrays — same schema as a kind:39701, minus the kind. */
type InnerEntries = string[][][];

interface PrivateSet {
  entries: InnerEntries;
  baseEventId?: string;
  chunkNames?: string[];
  savedAt?: number;
}

// ── Encrypt / decrypt helpers ─────────────────────────────────────────

function conversationKey(nsecHex: string, ownPubkey: string): Uint8Array {
  // NIP-44 self-encryption: sender + recipient = same pubkey.
  return nip44.v2.utils.getConversationKey(hexToBytes(nsecHex), ownPubkey);
}

function decryptEntries(event: NostrEvent | null, nsecHex: string, ownPubkey: string): PrivateSet {
  if (!event) return { entries: [] };
  if (event.pubkey !== ownPubkey) return { entries: [], baseEventId: event.id };
  try {
    const ck = conversationKey(nsecHex, ownPubkey);
    const plaintext = nip44.v2.decrypt(event.content, ck);
    const parsed = JSON.parse(plaintext);
    if (!isValidEntriesShape(parsed)) return { entries: [], baseEventId: event.id };
    return { entries: parsed, baseEventId: event.id };
  } catch {
    // Corrupt ciphertext / wrong key / bad JSON — treat as empty
    // rather than crashing the popup. Caller may still publish a
    // fresh set on top.
    return { entries: [], baseEventId: event.id };
  }
}

function isValidEntriesShape(value: unknown): value is InnerEntries {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.every(
        (tag) => Array.isArray(tag) && tag.every((cell) => typeof cell === 'string'),
      ),
  );
}

function dTag(tags: string[][]): string | undefined {
  return tags.find((t) => t[0] === 'd')?.[1];
}

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

function privateSetNameForIndex(index: number): string {
  return index === 0 ? PRIVATE_SET_NAME : `${PRIVATE_SET_CHUNK_PREFIX}${index}`;
}

function privateSetIndexFromName(name: string | undefined): number | null {
  if (name === PRIVATE_SET_NAME) return 0;
  if (!name?.startsWith(PRIVATE_SET_CHUNK_PREFIX)) return null;
  const raw = name.slice(PRIVATE_SET_CHUNK_PREFIX.length);
  if (!/^[1-9]\d*$/.test(raw)) return null;
  return Number(raw);
}

function encodedJsonBytes(entries: InnerEntries): number {
  return new TextEncoder().encode(JSON.stringify(entries)).byteLength;
}

function chunkPrivateSetEntries(entries: InnerEntries): InnerEntries[] {
  if (entries.length === 0) return [[]];
  const chunks: InnerEntries[] = [];
  let current: InnerEntries = [];
  for (const entry of entries) {
    const next = [...current, entry];
    if (current.length > 0 && encodedJsonBytes(next) > MAX_PRIVATE_SET_PLAINTEXT_BYTES) {
      chunks.push(current);
      current = [entry];
    } else {
      current = next;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function newPrivateSetVersion(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function selectCompletePrivateSetEvents(events: NostrEvent[]): NostrEvent[] {
  const records = events
    .map((event) => ({
      event,
      index: privateSetIndexFromName(dTag(event.tags)),
      version: tagValue(event.tags, SET_VERSION_TAG),
      count: Number(tagValue(event.tags, SET_COUNT_TAG)),
    }))
    .filter((record): record is {
      event: NostrEvent;
      index: number;
      version: string | undefined;
      count: number;
    } => record.index !== null);

  const primaries = records
    .filter((record) => record.index === 0)
    .sort((a, b) => b.event.created_at - a.event.created_at);

  for (const primary of primaries) {
    if (primary.version && Number.isInteger(primary.count) && primary.count > 0) {
      const group = new Map<number, NostrEvent>();
      for (const record of records) {
        if (record.version !== primary.version) continue;
        if (record.index < 0 || record.index >= primary.count) continue;
        const current = group.get(record.index);
        if (!current || record.event.created_at > current.created_at) group.set(record.index, record.event);
      }
      if (group.size === primary.count) {
        return Array.from(group.entries())
          .sort(([a], [b]) => a - b)
          .map(([, event]) => event);
      }
      continue;
    }

    const latestLegacyByIndex = new Map<number, NostrEvent>();
    for (const record of records) {
      if (record.version) continue;
      const current = latestLegacyByIndex.get(record.index);
      if (!current || record.event.created_at > current.created_at) {
        latestLegacyByIndex.set(record.index, record.event);
      }
    }
    return Array.from(latestLegacyByIndex.entries())
      .sort(([a], [b]) => a - b)
      .map(([, event]) => event);
  }

  return [];
}

async function fetchPrivateSetEvents(
  pool: ReturnType<typeof sharedPool>,
  readRelays: string[],
  ownPubkey: string,
): Promise<NostrEvent[]> {
  const events = await pool.querySync(
    readRelays,
    {
      kinds: [KIND_PRIVATE_SET],
      authors: [ownPubkey],
      limit: 500,
    },
    { maxWait: 4000 },
  ).catch(() => [] as NostrEvent[]);
  return selectCompletePrivateSetEvents(events);
}

async function fetchCurrentPrivateSet(
  pool: ReturnType<typeof sharedPool>,
  readRelays: string[],
  nsecHex: string,
  ownPubkey: string,
): Promise<PrivateSet> {
  const events = await fetchPrivateSetEvents(pool, readRelays, ownPubkey);
  const entries: InnerEntries = [];
  const chunkNames: string[] = [];
  let baseEventId = '';
  let savedAt = 0;
  for (const event of events) {
    const name = dTag(event.tags);
    if (name) chunkNames.push(name);
    const set = decryptEntries(event, nsecHex, ownPubkey);
    entries.push(...set.entries);
    if (!baseEventId) baseEventId = event.id;
    savedAt = Math.max(savedAt, event.created_at);
  }
  return {
    entries,
    baseEventId: baseEventId || undefined,
    chunkNames,
    savedAt: savedAt || undefined,
  };
}

function buildPrivateSetEvents(
  entries: InnerEntries,
  previousChunkNames: string[] | undefined,
  nsecHex: string,
  ownPubkey: string,
): NostrEvent[] {
  const chunks = chunkPrivateSetEntries(entries);
  const previousMaxIndex = (previousChunkNames ?? []).reduce((max, name) => {
    const idx = privateSetIndexFromName(name);
    return idx === null ? max : Math.max(max, idx);
  }, -1);
  const count = Math.max(chunks.length, previousMaxIndex + 1, 1);
  const version = newPrivateSetVersion();
  const ck = conversationKey(nsecHex, ownPubkey);
  const sk = hexToBytes(nsecHex);
  return Array.from({ length: count }, (_, index) => {
    const ciphertext = nip44.v2.encrypt(JSON.stringify(chunks[index] ?? []), ck);
    return finalizeEvent(
      {
        kind: KIND_PRIVATE_SET,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', privateSetNameForIndex(index)],
          [SET_VERSION_TAG, version],
          [SET_COUNT_TAG, String(count)],
        ],
        content: ciphertext,
      },
      sk,
    );
  });
}

async function publishPrivateSetEvents(
  events: NostrEvent[],
  writeRelays: string[],
  pool: ReturnType<typeof sharedPool>,
): Promise<{ ok: string[]; failed: PublishFailure[] }> {
  const attempts = events.flatMap((event) =>
    writeRelays.map((url) => ({ event, url, promise: withTimeout(pool.publish([url], event)[0]!, 8000, url) })),
  );
  const results = await Promise.allSettled(attempts.map((attempt) => attempt.promise));
  const successCounts = new Map<string, number>();
  const failed: PublishFailure[] = [];
  results.forEach((result, index) => {
    const attempt = attempts[index]!;
    if (result.status === 'fulfilled') {
      successCounts.set(attempt.url, (successCounts.get(attempt.url) ?? 0) + 1);
    } else {
      failed.push({
        url: attempt.url,
        reason: `${dTag(attempt.event.tags) ?? PRIVATE_SET_NAME}: ${extractFailReason(result.reason)}`,
      });
    }
  });
  const failedRelays = new Set(failed.map((failure) => failure.url));
  const ok = writeRelays.filter((url) => !failedRelays.has(url) && successCounts.get(url) === events.length);
  return { ok, failed };
}

// ── Public API ────────────────────────────────────────────────────────

/** Convert a BookmarkInput into the inner tag array stored inside the
 *  encrypted set. Reuses the same buildBookmarkTemplate so the tag
 *  shape stays in sync with public bookmarks. */
function bookmarkInputToInnerTags(input: BookmarkInput): string[][] {
  return buildBookmarkTemplate(input).tags;
}

/**
 * Publish a private bookmark by appending it to the user's encrypted
 * NIP-51 set. Fetches the current set, decrypts, appends, re-encrypts,
 * republishes the whole kind:30003. Returns the publish result the
 * same shape as publishBookmark for caller symmetry.
 */
export async function publishPrivateBookmark(
  input: BookmarkInput,
  nsecHex: string,
  ownPubkey: string,
): Promise<{ event: NostrEvent; ok: string[]; failed: PublishFailure[] }> {
  const pool = sharedPool();
  const readRelays = await getReadRelays();
  const writeRelays = await getWriteRelays();

  // 1. Fetch + decrypt the current chunked private set.
  const set = await fetchCurrentPrivateSet(pool, readRelays, nsecHex, ownPubkey);

  // 2. Append (or replace if same URL — d-tag de-dup mirrors public flow).
  const innerTags = bookmarkInputToInnerTags(input);
  const dTagOf = (tags: string[][]) => tags.find((t) => t[0] === 'd')?.[1];
  const newUrl = dTagOf(innerTags);
  const next = set.entries
    .filter((entry) => dTagOf(entry) !== newUrl)
    .concat([innerTags]);

  // 3. Re-encrypt + sign + publish every chunk as one logical set version.
  const events = buildPrivateSetEvents(next, set.chunkNames, nsecHex, ownPubkey);
  const { ok, failed } = await publishPrivateSetEvents(events, writeRelays, pool);
  return { event: events[0]!, ok, failed };
}

/**
 * Remove one entry from the user's private bookmark set, identified by
 * URL (the inner `d` tag). Fetches → decrypts → filters → re-encrypts
 * → publishes. No-op if the URL isn't in the set.
 *
 * For private bookmarks there's no separate kind:5 deletion event —
 * the set is replaceable, so re-publishing without the entry is the
 * deletion. Older copies on relays get superseded by the new event's
 * created_at; clients seeing both keep the latest.
 */
export async function deletePrivateBookmark(
  url: string,
  nsecHex: string,
  ownPubkey: string,
): Promise<{ event: NostrEvent; ok: string[]; failed: PublishFailure[]; removed: boolean }> {
  const pool = sharedPool();
  const readRelays = await getReadRelays();
  const writeRelays = await getWriteRelays();

  const set = await fetchCurrentPrivateSet(pool, readRelays, nsecHex, ownPubkey);

  const dTagOf = (tags: string[][]) => tags.find((t) => t[0] === 'd')?.[1];
  const before = set.entries.length;
  const next = set.entries.filter((entry) => dTagOf(entry) !== url);
  const removed = next.length !== before;

  const events = buildPrivateSetEvents(next, set.chunkNames, nsecHex, ownPubkey);
  const { ok, failed } = await publishPrivateSetEvents(events, writeRelays, pool);
  return { event: events[0]!, ok, failed, removed };
}

/** List the user's private bookmarks. Returns an array shaped like
 *  the parsed public bookmarks so the Recent screen can render either
 *  through one path. */
export async function fetchPrivateBookmarks(
  nsecHex: string,
  ownPubkey: string,
): Promise<Array<{
  url: string;
  title: string;
  description: string;
  tags: string[];
  archived: boolean;
  savedAt: number;
  eventId: string;
}>> {
  const pool = sharedPool();
  const readRelays = await getReadRelays();
  const set = await fetchCurrentPrivateSet(pool, readRelays, nsecHex, ownPubkey);
  return set.entries.map((tags) => {
    const get = (name: string) => tags.find((t) => t[0] === name)?.[1];
    return {
      url: get('d') ?? '',
      title: get('title') ?? get('d') ?? '',
      description: get('description') ?? '',
      tags: tags.filter((t) => t[0] === 't').map((t) => t[1] ?? '').filter(Boolean),
      archived: get('archive-tier') === 'forever',
      savedAt: set.savedAt ?? Math.floor(Date.now() / 1000),
      eventId: set.baseEventId ?? '',
    };
  }).filter((b) => /^https?:/i.test(b.url));
}

// Local helper duplicated from nostr.ts so this module is independently
// importable without circular pulls. ~6 lines, not worth a shared file.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout: ${label}`)), ms),
    ),
  ]);
}

// Re-export so callers can pattern-match KIND_BOOKMARK vs KIND_PRIVATE_SET
// when needed.
export { KIND_BOOKMARK };
