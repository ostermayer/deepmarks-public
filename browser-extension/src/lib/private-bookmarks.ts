// NIP-51 private bookmark set — kind:30003, NIP-44 v2 encrypted to self.
//
// Mirrors frontend/src/lib/nostr/private-bookmarks.ts in shape so a
// bookmark saved privately from the extension shows up in the web
// app's private feed unchanged. The `d` tag is the set name —
// "deepmarks-private" by convention — and the `content` is the JSON
// of an array-of-tag-arrays, encrypted to the user's own pubkey.

import { finalizeEvent, nip44, type Event as NostrEvent } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';
import {
  sharedPool,
  parseUnixMillis,
  parseUnixSeconds,
  postSignedEvent,
  type PublishFailure,
} from './nostr.js';
import { getReadRelays, getWriteRelays } from './settings-store.js';
import { buildBookmarkTemplate, type BookmarkInput } from './nostr.js';
import {
  isValidEntriesShape,
  mergePrivateSetEventEntries,
  privateItemSetNameForUrl,
  selectPrivateBookmarkSetEvents,
} from './private-set-core.js';

const KIND_PRIVATE_SET = 30003;

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

function decryptEntries(
  event: NostrEvent | null,
  nsecHex: string,
  ownPubkey: string,
): PrivateSet & { failed?: boolean } {
  if (!event) return { entries: [] };
  if (event.pubkey !== ownPubkey) return { entries: [], baseEventId: event.id, failed: true };
  try {
    const ck = conversationKey(nsecHex, ownPubkey);
    const plaintext = nip44.v2.decrypt(event.content, ck);
    const parsed = JSON.parse(plaintext);
    if (!isValidEntriesShape(parsed)) return { entries: [], baseEventId: event.id, failed: true };
    return { entries: parsed, baseEventId: event.id };
  } catch {
    // Corrupt ciphertext / wrong key / bad JSON — don't crash the popup,
    // but FLAG the failure: a whole-set rewrite built on top of a chunk
    // we couldn't read would erase that chunk's bookmarks relay-wide.
    return { entries: [], baseEventId: event.id, failed: true };
  }
}


async function fetchPrivateSetEvents(
  pool: ReturnType<typeof sharedPool>,
  readRelays: string[],
  ownPubkey: string,
): Promise<NostrEvent[]> {
  // NOTE: read failures must PROPAGATE. Swallowing them into an empty
  // array made a later save publish a complete 1-entry replacement set —
  // wiping the user's private library on every device. The publish goes
  // over HTTPS and can succeed exactly when the websocket read is broken.
  const events = await pool.querySync(
    readRelays,
    {
      kinds: [KIND_PRIVATE_SET],
      authors: [ownPubkey],
      limit: 2000,
    },
    { maxWait: 4000 },
  );
  return selectPrivateBookmarkSetEvents(events);
}

async function fetchCurrentPrivateSet(
  pool: ReturnType<typeof sharedPool>,
  readRelays: string[],
  nsecHex: string,
  ownPubkey: string,
): Promise<PrivateSet> {
  const events = await fetchPrivateSetEvents(pool, readRelays, ownPubkey);
  const decryptedEvents = events.map((event) => ({
    id: event.id,
    createdAt: event.created_at,
    tags: event.tags,
    entries: decryptEntries(event, nsecHex, ownPubkey).entries,
  }));
  return mergePrivateSetEventEntries(decryptedEvents);
}


async function buildPrivateItemEvent(
  entries: InnerEntries,
  url: string,
  nsecHex: string,
  ownPubkey: string,
): Promise<NostrEvent> {
  const ck = conversationKey(nsecHex, ownPubkey);
  const sk = hexToBytes(nsecHex);
  const ciphertext = nip44.v2.encrypt(JSON.stringify(entries), ck);
  return finalizeEvent(
    {
      kind: KIND_PRIVATE_SET,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', await privateItemSetNameForUrl(url)]],
      content: ciphertext,
    },
    sk,
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
  const writeRelays = await getWriteRelays();

  // PER-ITEM write path: one replaceable event keyed by the URL hash.
  // Every shipped reader (web, extension, iOS) merges item events with
  // the chunked set, newest per URL wins. No fetch, no decrypt of
  // existing chunks, no whole-set replacement — the wipe class this
  // file used to defend against can no longer occur on the save path.
  const innerTags = bookmarkInputToInnerTags(input);
  const event = await buildPrivateItemEvent([innerTags], input.url, nsecHex, ownPubkey);
  const { ok, failed } = await postSignedEvent(event, nsecHex, { relays: writeRelays, pool });
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
  const writeRelays = await getWriteRelays();

  // PER-ITEM delete: the tombstone alone is authoritative in every
  // reader's merge — no chunk rewrite needed.
  const event = await buildPrivateItemEvent([[['d', url], ['deleted', '1']]], url, nsecHex, ownPubkey);
  const { ok, failed } = await postSignedEvent(event, nsecHex, { relays: writeRelays, pool });
  return { event, ok, failed, removed: true };
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
  savedAtMs?: number;
  publishedAt?: number;
  publishedAtMs?: number;
  eventId: string;
  lightning?: string;
  blossomHash?: string;
  waybackUrl?: string;
}>> {
  const pool = sharedPool();
  const readRelays = await getReadRelays();
  const set = await fetchCurrentPrivateSet(pool, readRelays, nsecHex, ownPubkey);
  return set.entries.map((tags) => {
    const get = (name: string) => tags.find((t) => t[0] === name)?.[1];
    const publishedAt = parseUnixSeconds(get('published_at'));
    const savedAt = publishedAt ?? set.savedAt ?? Math.floor(Date.now() / 1000);
    const publishedAtMs = parseUnixMillis(get('published_at_ms'), savedAt);
    return {
      url: get('d') ?? '',
      title: get('title') ?? get('d') ?? '',
      description: get('description') ?? '',
      tags: tags.filter((t) => t[0] === 't').map((t) => t[1] ?? '').filter(Boolean),
      archived: get('archive-tier') === 'forever',
      savedAt,
      savedAtMs: publishedAtMs,
      publishedAt,
      publishedAtMs,
      eventId: set.baseEventId ?? '',
      lightning: get('lightning'),
      blossomHash: get('blossom'),
      waybackUrl: get('wayback'),
    };
  }).filter((b) => /^https?:/i.test(b.url));
}

// withTimeout used to wrap relay-WS publishes here; the
// server-mediated /publish endpoint owns the timeout now.

