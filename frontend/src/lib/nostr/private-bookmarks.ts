// NIP-51 private bookmark set — kind:30003, NIP-44 v2 encrypted to self.
// CLAUDE.md: encrypt to OWN pubkey. NIP-44 v2 only. Validate decryption on
// read; corrupt ciphertext must not crash the UI.
//
// Set shape (after decryption): JSON array of inner tag arrays. We keep the
// `["d", "<url>"]` + the same metadata tags as the public bookmark schema
// inside the encrypted blob — this gives flow F (toggle private↔public) a
// clean migration path.

import { NDKEvent } from '@nostr-dev-kit/ndk';
import { getNdk } from './ndk.js';
import { KIND } from './kinds.js';
import {
  buildBookmarkEvent,
  type BookmarkInput,
  type SignedEventLike,
  type UnsignedEventTemplate
} from './bookmarks.js';

const SET_NAME = 'deepmarks-private';

export interface PrivateSet {
  /** Inner tag arrays — same schema as a kind:39701, minus the kind. */
  entries: string[][][];
  /** Last seen event id, if any. */
  baseEventId?: string;
}

export type DecryptResult =
  | { ok: true; set: PrivateSet }
  | { ok: false; reason: 'no-event' | 'no-signer' | 'wrong-key' | 'corrupt-json' | 'wrong-shape' };

/**
 * Validate the decrypted-JSON shape — array of arrays of strings — so the
 * downstream `string[][][]` cast is actually safe.
 */
export function isValidEntriesShape(value: unknown): value is string[][][] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.every(
        (tag) => Array.isArray(tag) && tag.every((cell) => typeof cell === 'string')
      )
  );
}

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
    plaintext = await ndk.signer.decrypt(me, event.content, 'nip44');
  } catch {
    return { ok: false, reason: 'wrong-key' };
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
  return { ok: true, set: { entries: parsed, baseEventId: event.id } };
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
  return { entries: [], baseEventId: event.id };
}

export async function buildPrivateSetEvent(
  set: PrivateSet,
  ownerPubkey: string
): Promise<UnsignedEventTemplate> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('No signer attached. Sign in first.');
  const me = ndk.getUser({ pubkey: ownerPubkey });
  const ciphertext = await ndk.signer.encrypt(me, JSON.stringify(set.entries), 'nip44');
  return {
    kind: KIND.privateBookmarkSet,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', SET_NAME]],
    content: ciphertext
  };
}

/** Convert a BookmarkInput into the inner tag array stored inside the encrypted set. */
export function bookmarkInputToInnerTags(input: BookmarkInput): string[][] {
  // Reuse buildBookmarkEvent's tag construction to avoid drift.
  return buildBookmarkEvent(input).tags;
}

/** Convert one decrypted private-set entry (inner tag array) into a
 *  ParsedBookmark so private + public bookmarks can render through the
 *  same components and aggregate into the same stats / tag-cloud
 *  derivations. The set itself doesn't carry per-entry timestamps, so
 *  callers pass the set event's created_at as savedAt — accurate to
 *  "the last time this set was published," which is the best signal
 *  we have without a redesign of the inner tag schema. */
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
  return {
    url,
    title: get('title') ?? url,
    description: get('description') ?? '',
    tags: tagValues,
    publishedAt: get('published_at') ? Number(get('published_at')) : undefined,
    lightning: get('lightning'),
    blossomHash: get('blossom'),
    waybackUrl: get('wayback'),
    archivedForever: get('archive-tier') === 'forever',
    savedAt,
    curator: ownerPubkey,
    // Synthetic id keyed by the URL — the set has one event id but
    // many entries; a stable per-URL id keeps Svelte's #each keys
    // stable across re-renders.
    eventId: `private:${url}`,
    // Mark for downstream consumers that don't already check the
    // ownerPubkey / id-prefix combo.
    ...({} as Record<string, never>),
  };
}

export async function fetchOwnPrivateSet(ownerPubkey: string): Promise<PrivateSet> {
  const ndk = getNdk();
  const event = await ndk.fetchEvent({
    kinds: [KIND.privateBookmarkSet],
    authors: [ownerPubkey],
    '#d': [SET_NAME]
  });
  return decryptPrivateSet(event as unknown as SignedEventLike | null);
}

export async function addToPrivateSet(
  input: BookmarkInput,
  ownerPubkey: string
): Promise<{ template: UnsignedEventTemplate; entries: string[][][] }> {
  const set = await fetchOwnPrivateSet(ownerPubkey);
  // De-dup by URL (d-tag): saving the same URL twice should replace,
  // not accumulate. Without this, repeated saves of the same article
  // grow the encrypted set unboundedly and make the Recent feed show
  // the same bookmark N times. Matches the extension's flow.
  const innerTags = bookmarkInputToInnerTags(input);
  const newUrl = innerTags.find((t) => t[0] === 'd')?.[1];
  const next = set.entries
    .filter((entry) => entry.find((t) => t[0] === 'd')?.[1] !== newUrl)
    .concat([innerTags]);
  const template = await buildPrivateSetEvent({ entries: next }, ownerPubkey);
  return { template, entries: next };
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
): Promise<{ template: UnsignedEventTemplate; entries: string[][][]; removed: boolean }> {
  const set = await fetchOwnPrivateSet(ownerPubkey);
  const before = set.entries.length;
  const next = set.entries.filter(
    (entry) => entry.find((t) => t[0] === 'd')?.[1] !== url,
  );
  const template = await buildPrivateSetEvent({ entries: next }, ownerPubkey);
  return { template, entries: next, removed: next.length < before };
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
): Promise<{ template: UnsignedEventTemplate; entries: string[][][] }> {
  const set = await fetchOwnPrivateSet(ownerPubkey);
  const next = set.entries.slice();
  const urlTag = (entry: string[][]) => entry.find((t) => t[0] === 'd')?.[1];
  const idx = next.findIndex((e) => urlTag(e) === input.url);
  const tags = bookmarkInputToInnerTags(input);
  if (idx >= 0) next[idx] = tags;
  else next.push(tags);
  const template = await buildPrivateSetEvent({ entries: next }, ownerPubkey);
  return { template, entries: next };
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
