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
import { canonicalRelaySet } from './canonical-relay-set.js';
import {
  buildBookmarkEvent,
  type BookmarkInput,
  type SignedEventLike,
  type UnsignedEventTemplate
} from './bookmarks.js';

const SET_NAME = 'deepmarks-private';
const SET_CHUNK_PREFIX = `${SET_NAME}-`;
const MAX_PRIVATE_SET_PLAINTEXT_BYTES = 60_000;
const SET_VERSION_TAG = 'dm-set-version';
const SET_COUNT_TAG = 'dm-set-count';

export interface PrivateSet {
  /** Inner tag arrays — same schema as a kind:39701, minus the kind. */
  entries: string[][][];
  /** Last seen event id, if any. */
  baseEventId?: string;
  /** Replaceable d-tags backing this logical set, in chunk order. */
  chunkNames?: string[];
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
  ownerPubkey: string,
  setName = SET_NAME,
): Promise<UnsignedEventTemplate> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('No signer attached. Sign in first.');
  const me = ndk.getUser({ pubkey: ownerPubkey });
  const ciphertext = await ndk.signer.encrypt(me, JSON.stringify(set.entries), 'nip44');
  return {
    kind: KIND.privateBookmarkSet,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', setName]],
    content: ciphertext
  };
}

export function privateSetNameForIndex(index: number): string {
  return index === 0 ? SET_NAME : `${SET_CHUNK_PREFIX}${index}`;
}

export function privateSetIndexFromName(name: string | undefined): number | null {
  if (name === SET_NAME) return 0;
  if (!name?.startsWith(SET_CHUNK_PREFIX)) return null;
  const raw = name.slice(SET_CHUNK_PREFIX.length);
  if (!/^[1-9]\d*$/.test(raw)) return null;
  return Number(raw);
}

function dTag(tags: string[][]): string | undefined {
  return tags.find((t) => t[0] === 'd')?.[1];
}

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

function encodedJsonBytes(entries: string[][][]): number {
  return new TextEncoder().encode(JSON.stringify(entries)).byteLength;
}

export function chunkPrivateSetEntries(
  entries: string[][][],
  maxBytes = MAX_PRIVATE_SET_PLAINTEXT_BYTES,
): string[][][][] {
  if (entries.length === 0) return [[]];
  const chunks: string[][][][] = [];
  let current: string[][][] = [];
  for (const entry of entries) {
    const next = [...current, entry];
    if (current.length > 0 && encodedJsonBytes(next) > maxBytes) {
      chunks.push(current);
      current = [entry];
    } else {
      current = next;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
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

function newPrivateSetVersion(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
  const publishedAt = parseUnixSeconds(get('published_at'));
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
    savedAt: publishedAt ?? savedAt,
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

function parseUnixSeconds(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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
      limit: 500,
    },
    relaySet ? { groupable: false } : undefined,
    relaySet ?? undefined,
  ));
  return selectCompletePrivateSetEvents(events.map((raw) => ndkEventAsSigned(raw as NDKEvent)));
}

export function selectCompletePrivateSetEvents(events: SignedEventLike[]): SignedEventLike[] {
  const records = events
    .map((event) => ({
      event,
      index: privateSetIndexFromName(dTag(event.tags)),
      version: tagValue(event.tags, SET_VERSION_TAG),
      count: Number(tagValue(event.tags, SET_COUNT_TAG)),
    }))
    .filter((record): record is {
      event: SignedEventLike;
      index: number;
      version: string | undefined;
      count: number;
    } => record.index !== null);

  const primaries = records
    .filter((record) => record.index === 0)
    .sort((a, b) => b.event.created_at - a.event.created_at);

  for (const primary of primaries) {
    if (primary.version && Number.isInteger(primary.count) && primary.count > 0) {
      const group = new Map<number, SignedEventLike>();
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

    const latestLegacyByIndex = new Map<number, SignedEventLike>();
    for (const record of records) {
      if (record.version) continue;
      const current = latestLegacyByIndex.get(record.index);
      if (!current || record.event.created_at > current.created_at) {
        latestLegacyByIndex.set(record.index, record.event);
      }
    }
    if (latestLegacyByIndex.size > 0) {
      return Array.from(latestLegacyByIndex.entries())
        .sort(([a], [b]) => a - b)
        .map(([, event]) => event);
    }
  }

  // Last-resort union: no single version is complete (a partial save
  // failed mid-publish, or two clients started overlapping rewrites).
  // Rather than show the user nothing, take the latest event per chunk
  // index across all versions. This recovers their data when chunks
  // are split between an in-progress new version and an older one,
  // which is exactly the "bookmarks vanished" gap we saw in the wild.
  if (records.length === 0) return [];
  const unionByIndex = new Map<number, SignedEventLike>();
  for (const record of records) {
    if (record.index < 0) continue;
    const current = unionByIndex.get(record.index);
    if (!current || record.event.created_at > current.created_at) {
      unionByIndex.set(record.index, record.event);
    }
  }
  return Array.from(unionByIndex.entries())
    .sort(([a], [b]) => a - b)
    .map(([, event]) => event);
}

export async function fetchOwnPrivateSet(
  ownerPubkey: string,
  extraRelays: readonly string[] = [],
): Promise<PrivateSet> {
  const events = await fetchOwnPrivateSetEvents(ownerPubkey, extraRelays);
  if (events.length === 0) return { entries: [] };
  const entries: string[][][] = [];
  const chunkNames: string[] = [];
  for (const event of events) {
    const name = dTag(event.tags);
    if (name) chunkNames.push(name);
    const result = await tryDecryptPrivateSet(event, ownerPubkey);
    if (result.ok) entries.push(...result.set.entries);
  }
  return { entries, baseEventId: events[0]?.id, chunkNames };
}

export async function addToPrivateSet(
  input: BookmarkInput,
  ownerPubkey: string
): Promise<{ template: UnsignedEventTemplate; templates: UnsignedEventTemplate[]; entries: string[][][] }> {
  const set = await fetchOwnPrivateSet(ownerPubkey);

  // UNION with local privateBookmarks store so prior saves whose
  // chunk publishes were rejected by flaky relays (nos.lol /
  // nostr.land / damus / primal etc.) don't get silently dropped
  // when we republish. Symptom this prevents: user saves bookmark A,
  // chunk publish partially fails → relay has stale chunks → next
  // save fetches the relay's stale set, republishes without A → A
  // is lost from the relay forever. With this union, every locally-
  // known entry rides along until the publish actually succeeds.
  const relayUrls = new Set<string>();
  for (const entry of set.entries) {
    const u = entry.find((t) => t[0] === 'd')?.[1];
    if (u) relayUrls.add(u);
  }
  const localExtras: string[][][] = [];
  try {
    // Read straight from the localStorage cache that own-bookmarks
    // persists private entries to (see lsSavePrivate). Going through
    // the store would introduce a circular import; the cache shape
    // is stable so read it directly.
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(`deepmarks-private-bookmarks:v3:${ownerPubkey}`);
      if (raw) {
        const parsed = JSON.parse(raw) as Array<{
          url?: string;
          title?: string;
          description?: string;
          tags?: string[];
          publishedAt?: number;
          savedAt?: number;
        }>;
        if (Array.isArray(parsed)) {
          for (const b of parsed) {
            if (!b || typeof b !== 'object') continue;
            if (typeof b.url !== 'string' || !b.url) continue;
            if (relayUrls.has(b.url)) continue;
            localExtras.push(bookmarkInputToInnerTags({
              url: b.url,
              title: b.title,
              description: b.description,
              tags: Array.isArray(b.tags) ? b.tags : [],
              // Carry forward the original save time so cross-device
              // sort ordering stays stable. Prefer explicit publishedAt
              // (set by saveBookmark going forward), fall back to the
              // ParsedBookmark.savedAt the local cache already tracks
              // (set by parsePrivateEntry on the previous decryption).
              publishedAt: typeof b.publishedAt === 'number'
                ? b.publishedAt
                : typeof b.savedAt === 'number'
                  ? b.savedAt
                  : undefined,
            }));
          }
        }
      }
    }
  } catch {
    // Quota / corrupt JSON / SSR — fall through with no extras.
  }

  // De-dup by URL (d-tag): saving the same URL twice should replace,
  // not accumulate. Without this, repeated saves of the same article
  // grow the encrypted set unboundedly and make the Recent feed show
  // the same bookmark N times. Matches the extension's flow.
  const innerTags = bookmarkInputToInnerTags(input);
  const newUrl = innerTags.find((t) => t[0] === 'd')?.[1];
  const next = [...set.entries, ...localExtras]
    .filter((entry) => entry.find((t) => t[0] === 'd')?.[1] !== newUrl)
    .concat([innerTags]);
  const templates = await buildPrivateSetReplacementEvents(
    { entries: next },
    ownerPubkey,
    set.chunkNames,
  );
  return { template: templates[0]!, templates, entries: next };
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
  const set = await fetchOwnPrivateSet(ownerPubkey);
  const before = set.entries.length;
  const next = set.entries.filter(
    (entry) => entry.find((t) => t[0] === 'd')?.[1] !== url,
  );
  const templates = await buildPrivateSetReplacementEvents(
    { entries: next },
    ownerPubkey,
    set.chunkNames,
  );
  return { template: templates[0]!, templates, entries: next, removed: next.length < before };
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
  const set = await fetchOwnPrivateSet(ownerPubkey);
  const next = set.entries.slice();
  const urlTag = (entry: string[][]) => entry.find((t) => t[0] === 'd')?.[1];
  const idx = next.findIndex((e) => urlTag(e) === input.url);
  const tags = bookmarkInputToInnerTags(input);
  if (idx >= 0) next[idx] = tags;
  else next.push(tags);
  const templates = await buildPrivateSetReplacementEvents(
    { entries: next },
    ownerPubkey,
    set.chunkNames,
  );
  return { template: templates[0]!, templates, entries: next };
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
