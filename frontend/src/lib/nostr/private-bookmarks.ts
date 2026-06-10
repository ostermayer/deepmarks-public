// NIP-51 private bookmark set — kind:30003, NIP-44 v2 encrypted to self.
// Encrypt to the user's own pubkey with NIP-44 v2 only. Validate
// decryption on read; corrupt ciphertext must not crash the UI.
//
// Set shape (after decryption): JSON array of inner tag arrays. We keep the
// `["d", "<url>"]` + the same metadata tags as the public bookmark schema
// inside the encrypted blob — this gives flow F (toggle private↔public) a
// clean migration path.

import { NDKEvent } from '@nostr-dev-kit/ndk';
import { getNdk } from './ndk.js';
import { KIND } from './kinds.js';
import { SIGNER_OP_TIMEOUT_MS, TimeoutError, withTimeout } from '$lib/util/promise-timeout.js';
import {
  MAX_PRIVATE_SET_PLAINTEXT_BYTES,
  PRIVATE_SET_COUNT_TAG as SET_COUNT_TAG,
  PRIVATE_SET_NAME as SET_NAME,
  PRIVATE_SET_VERSION_TAG as SET_VERSION_TAG,
  chunkPrivateSetEntries,
  isPrivateItemSetName,
  isValidEntriesShape,
  mergePrivateSetEventEntries,
  newPrivateSetVersion,
  privateEntryUrl as entryUrl,
  privateItemSetNameForUrl,
  privateSetIndexFromName,
  privateSetNameForIndex,
  selectCompletePrivateSetEvents,
  selectLatestPrivateItemEvents,
  selectPrivateBookmarkSetEvents,
  type DecryptedPrivateSetEventCore,
} from './private-set-core.js';

// Re-export the shared core surface so existing imports (stores, tests)
// keep working unchanged.
export {
  chunkPrivateSetEntries,
  isPrivateItemSetName,
  isValidEntriesShape,
  mergePrivateSetEventEntries,
  privateItemSetNameForUrl,
  privateSetIndexFromName,
  privateSetNameForIndex,
  selectCompletePrivateSetEvents,
  selectLatestPrivateItemEvents,
  selectPrivateBookmarkSetEvents,
};

export type DecryptedPrivateSetEvent = DecryptedPrivateSetEventCore;
import { canonicalRelaySet } from './canonical-relay-set.js';
import {
  buildBookmarkEvent,
  parseUnixMillisTag,
  parseUnixSecondsTag,
  type BookmarkInput,
  type SignedEventLike,
  type UnsignedEventTemplate
} from './bookmarks.js';

export interface PrivateSet {
  /** Inner tag arrays — same schema as a kind:39701, minus the kind. */
  entries: string[][][];
  /** Last seen event id, if any. */
  baseEventId?: string;
  /** created_at of the primary private-set event. Used only as a
   *  deterministic fallback for legacy entries without published_at. */
  createdAt?: number;
  /** Replaceable d-tags backing this logical set, in chunk order. */
  chunkNames?: string[];
  /** Count of fetched set events whose content could not be decrypted.
   *  Non-zero means `entries` is an INCOMPLETE view — rewrite paths must
   *  refuse to republish on top of it or the missing entries are erased
   *  relay-wide. */
  decryptFailures?: number;
  /** Why decryption failed (first failure seen) — lets the UI explain
   *  "reconnect your signer" vs "your signer can't do nip44". */
  decryptFailureReason?: DecryptFailureReason;
  /** URL → created_at of the newest delete tombstone seen for it. Lets
   *  cache-union and store merges drop entries another device deleted. */
  deletedUrls?: Record<string, number>;
}

export type DecryptFailureReason =
  | 'no-event'
  | 'no-signer'
  | 'wrong-key'
  | 'corrupt-json'
  | 'wrong-shape'
  | 'signer-timeout'
  | 'nip44-unsupported';

export type DecryptResult =
  | { ok: true; set: PrivateSet }
  | { ok: false; reason: DecryptFailureReason };


/**
 * Strict variant — returns a tagged result so callers can distinguish "not
 * mine / wrong key" from "corrupt data", and so the UI can recover sensibly.
 */
export async function tryDecryptPrivateSet(
  event: SignedEventLike | null,
  expectedOwnerPubkey: string
): Promise<DecryptResult> {
  if (!event) return { ok: false, reason: 'no-event' };
  const ndk = getNdk();
  if (!ndk.signer) return { ok: false, reason: 'no-signer' };
  if (event.pubkey !== expectedOwnerPubkey) return { ok: false, reason: 'wrong-key' };

  let plaintext: string;
  try {
    const me = ndk.getUser({ pubkey: event.pubkey });
    // Remote signers (NIP-46 bunker, Amber) settle only when the signer
    // replies; without a ceiling a sleeping phone hangs the whole
    // private refresh and its loading latch forever.
    plaintext = await withTimeout(
      ndk.signer.decrypt(me, event.content, 'nip44'),
      SIGNER_OP_TIMEOUT_MS,
      'private bookmark decrypt',
    );
  } catch (err) {
    return { ok: false, reason: decryptErrorReason(err) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return { ok: false, reason: 'corrupt-json' };
  }
  if (!isValidEntriesShape(parsed)) {
    return { ok: false, reason: 'wrong-shape' };
  }
  return { ok: true, set: { entries: parsed, baseEventId: event.id, createdAt: event.created_at } };
}

function decryptErrorReason(err: unknown): DecryptFailureReason {
  if (err instanceof TimeoutError) return 'signer-timeout';
  const message = err instanceof Error ? err.message : String(err);
  // NDK + our NIP-07 signer both phrase missing-capability errors around
  // the scheme name ("nip44 encryption is not available from your
  // browser extension", "nip44encryption is not available…").
  if (/nip-?44/i.test(message) && /not (?:available|supported)/i.test(message)) {
    return 'nip44-unsupported';
  }
  return 'wrong-key';
}

/**
 * UI-friendly wrapper — never throws, never propagates the failure reason.
 * Use `tryDecryptPrivateSet` when the failure mode matters.
 */
export async function decryptPrivateSet(event: SignedEventLike | null): Promise<PrivateSet> {
  if (!event) return { entries: [] };
  // Caller didn't tell us who they are; trust the event author for back-compat.
  const result = await tryDecryptPrivateSet(event, event.pubkey);
  if (result.ok) return result.set;
  return { entries: [], baseEventId: event.id, createdAt: event.created_at };
}

export async function buildPrivateSetEvent(
  set: PrivateSet,
  ownerPubkey: string,
  setName = SET_NAME,
): Promise<UnsignedEventTemplate> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('No signer attached. Sign in first.');
  const me = ndk.getUser({ pubkey: ownerPubkey });
  const ciphertext = await withTimeout(
    ndk.signer.encrypt(me, JSON.stringify(set.entries), 'nip44'),
    SIGNER_OP_TIMEOUT_MS,
    'private bookmark encrypt',
  );
  return {
    kind: KIND.privateBookmarkSet,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', setName]],
    content: ciphertext
  };
}

export async function buildPrivateItemEvent(
  input: BookmarkInput,
  ownerPubkey: string,
): Promise<UnsignedEventTemplate> {
  return buildPrivateItemEntriesEvent([bookmarkInputToInnerTags(input)], input.url, ownerPubkey);
}

export async function buildPrivateItemTombstoneEvent(
  url: string,
  ownerPubkey: string,
): Promise<UnsignedEventTemplate> {
  return buildPrivateItemEntriesEvent([[['d', url], ['deleted', '1']]], url, ownerPubkey);
}

async function buildPrivateItemEntriesEvent(
  entries: string[][][],
  url: string,
  ownerPubkey: string,
): Promise<UnsignedEventTemplate> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('No signer attached. Sign in first.');
  const me = ndk.getUser({ pubkey: ownerPubkey });
  const ciphertext = await withTimeout(
    ndk.signer.encrypt(me, JSON.stringify(entries), 'nip44'),
    SIGNER_OP_TIMEOUT_MS,
    'private bookmark encrypt',
  );
  return {
    kind: KIND.privateBookmarkSet,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', await privateItemSetNameForUrl(url)]],
    content: ciphertext
  };
}




export async function buildPrivateSetReplacementEvents(
  set: PrivateSet,
  ownerPubkey: string,
  previousChunkNames: string[] = [],
): Promise<UnsignedEventTemplate[]> {
  const templates: UnsignedEventTemplate[] = [];
  for await (const step of buildPrivateSetReplacementEventStream(set, ownerPubkey, previousChunkNames)) {
    templates.push(step.template);
  }
  return templates;
}

export interface PrivateSetReplacementEventStep {
  index: number;
  count: number;
  setName: string;
  entryCount: number;
  template: UnsignedEventTemplate;
}

export async function* buildPrivateSetReplacementEventStream(
  set: PrivateSet,
  ownerPubkey: string,
  previousChunkNames: string[] = [],
): AsyncGenerator<PrivateSetReplacementEventStep, void, void> {
  const chunks = chunkPrivateSetEntries(set.entries);
  const previousMaxIndex = previousChunkNames.reduce((max, name) => {
    const idx = privateSetIndexFromName(name);
    return idx === null ? max : Math.max(max, idx);
  }, -1);
  const count = Math.max(chunks.length, previousMaxIndex + 1, 1);
  const version = newPrivateSetVersion();
  for (let i = 0; i < count; i++) {
    const setName = privateSetNameForIndex(i);
    const chunkEntries = chunks[i] ?? [];
    const template = await buildPrivateSetEvent(
      { entries: chunkEntries },
      ownerPubkey,
      setName,
    );
    template.tags.push([SET_VERSION_TAG, version], [SET_COUNT_TAG, String(count)]);
    yield { index: i, count, setName, entryCount: chunkEntries.length, template };
  }
}


/** Convert a BookmarkInput into the inner tag array stored inside the encrypted set. */
export function bookmarkInputToInnerTags(input: BookmarkInput): string[][] {
  // Reuse buildBookmarkEvent's tag construction to avoid drift.
  return buildBookmarkEvent(input).tags;
}

/** Convert one decrypted private-set entry (inner tag array) into a
 *  ParsedBookmark so private + public bookmarks can render through the
 *  same components and aggregate into the same stats / tag-cloud
 *  derivations. Current entries carry `published_at` as the user's
 *  original save time; callers pass the set event's created_at only
 *  as a fallback for legacy entries. */
export function parsePrivateEntry(
  entry: string[][],
  ownerPubkey: string,
  savedAt: number,
  setEventId: string,
): import('./bookmarks.js').ParsedBookmark | null {
  const get = (name: string) => entry.find((t) => t[0] === name)?.[1];
  const url = get('d');
  if (!url) return null;
  try {
    const proto = new URL(url).protocol;
    if (proto !== 'http:' && proto !== 'https:') return null;
  } catch {
    return null;
  }
  const tagValues = entry
    .filter((t) => t[0] === 't')
    .map((t) => t[1] ?? '')
    .filter(Boolean);
  const publishedAt = parseUnixSecondsTag(get('published_at'));
  const effectiveSavedAt = publishedAt ?? savedAt;
  const publishedAtMs = parseUnixMillisTag(get('published_at_ms'), effectiveSavedAt);
  return {
    url,
    title: get('title') ?? url,
    description: get('description') ?? '',
    tags: tagValues,
    publishedAt,
    lightning: get('lightning'),
    blossomHash: get('blossom'),
    waybackUrl: get('wayback'),
    archivedForever: get('archive-tier') === 'forever',
    // Cross-device-consistent sort: prefer the inner-tag published_at
    // (saved into the chunk ciphertext by the saving client → every
    // device that decrypts sees the same value). Fall back to the
    // chunk event's created_at (`savedAt` param) only for legacy
    // entries that pre-date publishedAt support. Without this the
    // sort divergence was: iOS bumps locally, web bumps locally,
    // each device shows its own recent saves above the other's.
    savedAt: effectiveSavedAt,
    savedAtMs: publishedAtMs,
    curator: ownerPubkey,
    // Synthetic id keyed by the URL — the set has one event id but
    // many entries; a stable per-URL id keeps Svelte's #each keys
    // stable across re-renders.
    eventId: `private:${url}`,
  };
}

/**
 * Read the user's private-bookmark chunks from every relay they
 * might live on. Uses the canonical read-relay set (relay.deepmarks.org
 * + active Deepmarks list + user's NIP-65 advertised relays from
 * `extraRelays`) so NDK's default NIP-65 outbox routing can't silently
 * skip the canonical Deepmarks store.
 */
export async function fetchOwnPrivateSetEvents(
  ownerPubkey: string,
  extraRelays: readonly string[] = [],
): Promise<SignedEventLike[]> {
  const ndk = getNdk();
  const relaySet = canonicalRelaySet(extraRelays);
  const events = Array.from(await ndk.fetchEvents(
    {
      kinds: [KIND.privateBookmarkSet],
      authors: [ownerPubkey],
      limit: 2000,
    },
    relaySet ? { groupable: false } : undefined,
    relaySet ?? undefined,
  ));
  return selectPrivateBookmarkSetEvents(events.map((raw) => ndkEventAsSigned(raw as NDKEvent)));
}


export async function fetchOwnPrivateSet(
  ownerPubkey: string,
  extraRelays: readonly string[] = [],
): Promise<PrivateSet> {
  const events = await fetchOwnPrivateSetEvents(ownerPubkey, extraRelays);
  if (events.length === 0) return { entries: [] };
  const decryptedEvents: DecryptedPrivateSetEvent[] = [];
  let decryptFailures = 0;
  let decryptFailureReason: DecryptFailureReason | undefined;
  for (const event of events) {
    const result = await tryDecryptPrivateSet(event, ownerPubkey);
    if (!result.ok) {
      decryptFailures += 1;
      decryptFailureReason ??= result.reason;
      // A timed-out or capability-missing signer will fail every
      // remaining chunk the same way — don't serially burn the
      // timeout budget per chunk on a signer that is gone.
      if (result.reason === 'signer-timeout' || result.reason === 'nip44-unsupported') {
        decryptFailures += events.length - decryptedEvents.length - 1;
        break;
      }
    }
    decryptedEvents.push({
      id: event.id,
      createdAt: event.created_at,
      tags: event.tags,
      entries: result.ok ? result.set.entries : [],
    });
  }
  const merged = mergePrivateSetEventEntries(decryptedEvents);
  return { ...merged, decryptFailures, decryptFailureReason };
}

/** Throw when the fetched set is an incomplete view of relay state.
 *  Every add/remove/update republishes the WHOLE chunked set, so building
 *  on top of a partially-decrypted fetch silently erases whatever the
 *  unreadable chunks held — on every device, not just this one. */
export function assertPrivateSetRewriteSafe(set: PrivateSet): void {
  if (set.decryptFailures && set.decryptFailures > 0) {
    const hint =
      set.decryptFailureReason === 'nip44-unsupported'
        ? 'Your signer does not support NIP-44 encryption, which private bookmarks require.'
        : set.decryptFailureReason === 'signer-timeout'
          ? 'Your remote signer did not respond — check that it is online and try again.'
          : 'Reconnect your signer and try again.';
    throw new Error(
      `Couldn't decrypt ${set.decryptFailures} private bookmark chunk(s) — not rewriting the set. ${hint}`,
    );
  }
}


export async function addToPrivateSet(
  input: BookmarkInput,
  ownerPubkey: string
): Promise<{ template: UnsignedEventTemplate; templates: UnsignedEventTemplate[]; entries: string[][][] }> {
  // PER-ITEM write path: one replaceable event keyed by the URL hash
  // (d=deepmarks-private-item:<sha256(url)>). Every shipped reader —
  // web, extension, iOS (which has written these from its share sheet
  // for a while) — merges item events with the chunked set, newest per
  // URL wins. Compared to the old fetch→decrypt→rewrite-the-whole-set
  // cycle this needs NO read, NO decryption of existing chunks, and
  // cannot lose a concurrent edit on another device: the conflict
  // surface shrinks from the whole library to this single URL.
  const template = await buildPrivateItemEvent(input, ownerPubkey);
  return { template, templates: [template], entries: [bookmarkInputToInnerTags(input)] };
}

/**
 * Drop the entry matching `url` from the user's encrypted private set.
 * Used by the bookmark-edit delete flow for private bookmarks — NIP-09
 * kind:5 is the wrong primitive here because the bookmark data lives
 * *inside* a replaceable kind:30003, so we just republish the set
 * without the entry.
 *
 * Returns a template for the updated set. Caller is responsible for
 * publishing. If no matching entry is found the returned template is
 * still well-formed (the set is re-encrypted unchanged), so callers
 * can treat "already gone" as a no-op success.
 */
export async function removeFromPrivateSet(
  url: string,
  ownerPubkey: string,
): Promise<{
  template: UnsignedEventTemplate;
  templates: UnsignedEventTemplate[];
  entries: string[][][];
  removed: boolean;
}> {
  // PER-ITEM delete: the tombstone alone is authoritative — every
  // reader's merge drops a URL whose newest record is a tombstone, even
  // though older chunk generations still contain it. One small event
  // instead of re-encrypting and republishing every chunk.
  const template = await buildPrivateItemTombstoneEvent(url, ownerPubkey);
  return { template, templates: [template], entries: [], removed: true };
}

/**
 * Replace the entry in the user's private set matching `input.url` (d-tag)
 * with a fresh tag array built from `input`. Used by the archive flow to
 * stamp `blossom` + `archive-tier:forever` tags onto a previously-saved
 * private bookmark. If no matching entry exists the input is appended.
 */
export async function updatePrivateSetEntry(
  input: BookmarkInput,
  ownerPubkey: string,
): Promise<{ template: UnsignedEventTemplate; templates: UnsignedEventTemplate[]; entries: string[][][] }> {
  // PER-ITEM update: same d-tag as the original save, newer created_at
  // wins in every reader's merge — including over stale chunk copies.
  const template = await buildPrivateItemEvent(input, ownerPubkey);
  return { template, templates: [template], entries: [bookmarkInputToInnerTags(input)] };
}


/** Wrap an existing NDKEvent in our minimal SignedEventLike shape. */
export function ndkEventAsSigned(event: NDKEvent): SignedEventLike {
  return {
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind ?? 0,
    created_at: event.created_at ?? Math.floor(Date.now() / 1000),
    tags: event.tags,
    content: event.content,
    sig: event.sig
  };
}
