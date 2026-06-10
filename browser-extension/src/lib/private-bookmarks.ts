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
  extractFailReason,
  parseUnixMillis,
  parseUnixSeconds,
  postSignedEvent,
  type PublishFailure,
} from './nostr.js';
import { getReadRelays, getWriteRelays } from './settings-store.js';
import { buildBookmarkTemplate, type BookmarkInput, KIND_BOOKMARK } from './nostr.js';
import {
  PRIVATE_SET_NAME,
  isValidEntriesShape,
  mergePrivateSetEventEntries,
  privateItemSetNameForUrl,
  privateSetDTag as dTag,
  selectPrivateBookmarkSetEvents,
} from './private-set-core.js';

export const KIND_PRIVATE_SET = 30003;
export { PRIVATE_SET_NAME };

/** Inner tag arrays — same schema as a kind:39701, minus the kind. */
type InnerEntries = string[][][];

interface PrivateSet {
  entries: InnerEntries;
  baseEventId?: string;
  chunkNames?: string[];
  savedAt?: number;
  /** Count of fetched set events whose content could not be decrypted.
   *  Non-zero means `entries` is an INCOMPLETE view — rewrite paths must
   *  refuse to republish on top of it or the missing entries are erased
   *  relay-wide for every device. */
  decryptFailures?: number;
  /** Number of relay events the set was reconstructed from. */
  eventCount?: number;
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
  let decryptFailures = 0;
  const decryptedEvents = events.map((event) => {
    const result = decryptEntries(event, nsecHex, ownPubkey);
    if (result.failed) decryptFailures += 1;
    return {
      id: event.id,
      createdAt: event.created_at,
      tags: event.tags,
      entries: result.entries,
    };
  });
  return { ...mergePrivateSetEventEntries(decryptedEvents), decryptFailures, eventCount: events.length };
}




async function buildPrivateItemEntryEvent(
  innerTags: string[][],
  url: string,
  nsecHex: string,
  ownPubkey: string,
): Promise<NostrEvent> {
  const ck = conversationKey(nsecHex, ownPubkey);
  const sk = hexToBytes(nsecHex);
  const ciphertext = nip44.v2.encrypt(JSON.stringify([innerTags]), ck);
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

async function buildPrivateItemTombstoneEvent(
  url: string,
  nsecHex: string,
  ownPubkey: string,
): Promise<NostrEvent> {
  const ck = conversationKey(nsecHex, ownPubkey);
  const sk = hexToBytes(nsecHex);
  const ciphertext = nip44.v2.encrypt(JSON.stringify([[['d', url], ['deleted', '1']]]), ck);
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

/** Publish every chunk of the private-set update using the selected
 *  extension transport: server-mediated by default, direct to the
 *  write-enabled relay list when the user opts in. */
async function publishPrivateSetEvents(
  events: NostrEvent[],
  writeRelays: string[],
  pool: ReturnType<typeof sharedPool>,
  nsecHex: string,
): Promise<{ ok: string[]; failed: PublishFailure[] }> {
  const failed: PublishFailure[] = [];
  const okSet = new Set<string>();
  // Keep the loop event-by-event so direct mode can surface the relay
  // failures for the specific private chunk that failed.
  for (let i = 0; i < events.length; i += 50) {
    const batch = events.slice(i, i + 50);
    for (const event of batch) {
      const { ok, failed: batchFailed } = await postSignedEvent(event, nsecHex, {
        relays: writeRelays,
        pool,
      });
      for (const url of ok) okSet.add(url);
      for (const f of batchFailed) {
        failed.push({
          url: f.url,
          reason: `${dTag(event.tags) ?? PRIVATE_SET_NAME}: ${extractFailReason(f.reason)}`,
        });
      }
    }
  }
  return { ok: [...okSet], failed };
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
  const event = await buildPrivateItemEntryEvent(innerTags, input.url, nsecHex, ownPubkey);
  const { ok, failed } = await publishPrivateSetEvents([event], writeRelays, pool, nsecHex);
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
  const event = await buildPrivateItemTombstoneEvent(url, nsecHex, ownPubkey);
  const { ok, failed } = await publishPrivateSetEvents([event], writeRelays, pool, nsecHex);
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

// Re-export so callers can pattern-match KIND_BOOKMARK vs KIND_PRIVATE_SET
// when needed.
export { KIND_BOOKMARK };
