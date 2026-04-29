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

/** Inner tag arrays — same schema as a kind:39701, minus the kind. */
type InnerEntries = string[][][];

interface PrivateSet {
  entries: InnerEntries;
  baseEventId?: string;
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

  // 1. Fetch the current private set (latest replacement).
  const existing = await pool.querySync(
    readRelays,
    {
      kinds: [KIND_PRIVATE_SET],
      authors: [ownPubkey],
      '#d': [PRIVATE_SET_NAME],
      limit: 1,
    },
    { maxWait: 4000 },
  ).catch(() => [] as NostrEvent[]);
  const latest = existing.sort((a, b) => b.created_at - a.created_at)[0] ?? null;

  // 2. Decrypt.
  const set = decryptEntries(latest, nsecHex, ownPubkey);

  // 3. Append (or replace if same URL — d-tag de-dup mirrors public flow).
  const innerTags = bookmarkInputToInnerTags(input);
  const dTagOf = (tags: string[][]) => tags.find((t) => t[0] === 'd')?.[1];
  const newUrl = dTagOf(innerTags);
  const next = set.entries
    .filter((entry) => dTagOf(entry) !== newUrl)
    .concat([innerTags]);

  // 4. Re-encrypt + sign + publish.
  const ck = conversationKey(nsecHex, ownPubkey);
  const ciphertext = nip44.v2.encrypt(JSON.stringify(next), ck);
  const event = finalizeEvent(
    {
      kind: KIND_PRIVATE_SET,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', PRIVATE_SET_NAME]],
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

  const existing = await pool.querySync(
    readRelays,
    {
      kinds: [KIND_PRIVATE_SET],
      authors: [ownPubkey],
      '#d': [PRIVATE_SET_NAME],
      limit: 1,
    },
    { maxWait: 4000 },
  ).catch(() => [] as NostrEvent[]);
  const latest = existing.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
  const set = decryptEntries(latest, nsecHex, ownPubkey);

  const dTagOf = (tags: string[][]) => tags.find((t) => t[0] === 'd')?.[1];
  const before = set.entries.length;
  const next = set.entries.filter((entry) => dTagOf(entry) !== url);
  const removed = next.length !== before;

  const ck = conversationKey(nsecHex, ownPubkey);
  const ciphertext = nip44.v2.encrypt(JSON.stringify(next), ck);
  const event = finalizeEvent(
    {
      kind: KIND_PRIVATE_SET,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', PRIVATE_SET_NAME]],
      content: ciphertext,
    },
    hexToBytes(nsecHex),
  );

  const results = await Promise.allSettled(
    writeRelays.map((relayUrl) => withTimeout(pool.publish([relayUrl], event)[0]!, 8000, relayUrl)),
  );
  const ok: string[] = [];
  const failed: PublishFailure[] = [];
  results.forEach((r, i) => {
    const relayUrl = writeRelays[i]!;
    if (r.status === 'fulfilled') ok.push(relayUrl);
    else failed.push({ url: relayUrl, reason: extractFailReason(r.reason) });
  });
  return { event, ok, failed, removed };
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
  const events = await pool.querySync(
    readRelays,
    {
      kinds: [KIND_PRIVATE_SET],
      authors: [ownPubkey],
      '#d': [PRIVATE_SET_NAME],
      limit: 1,
    },
    { maxWait: 4000 },
  ).catch(() => [] as NostrEvent[]);
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
  const set = decryptEntries(latest, nsecHex, ownPubkey);
  return set.entries.map((tags) => {
    const get = (name: string) => tags.find((t) => t[0] === name)?.[1];
    return {
      url: get('d') ?? '',
      title: get('title') ?? get('d') ?? '',
      description: get('description') ?? '',
      tags: tags.filter((t) => t[0] === 't').map((t) => t[1] ?? '').filter(Boolean),
      archived: get('archive-tier') === 'forever',
      savedAt: latest?.created_at ?? Math.floor(Date.now() / 1000),
      eventId: latest?.id ?? '',
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
