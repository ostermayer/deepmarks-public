// Ingest kind:10003 / kind:30003 bookmark lists from other Nostr clients
// (Damus, Primal, Amethyst, Coracle, etc.). NIP-51 bookmark lists store
// references inside tags on a single replaceable event per user:
//
//   ["r", "https://…"]           → URL bookmark
//   ["e", "<eventId>"]           → kind:1 note reference (etc.)
//   ["a", "<kind>:<pubkey>:<d>"] → parametric-replaceable event ref (articles)
//   ["t", "<hashtag>"]           → hashtag follow (not a bookmark per se)
//
// Phase 1A handles only the `r` tag case — it's the easiest bridge because
// the target is a URL, so the imported record maps cleanly to the same
// ParsedBookmark shape that kind:39701 produces. This lets URLs a user
// bookmarked in Damus/Primal appear in Deepmarks without new rendering.
//
// Phase 1B adds `e` tag resolution into an ImportedNoteRef stream. Each
// note-ref carries only the target event id; the actual note content is
// fetched on demand via event-resolver.ts when a card tries to render it.
// The UI renders kind:1 targets only; a-tag (article) resolution is deferred.

import { readable, type Readable } from 'svelte/store';
import type { NDKEncryptionScheme, NDKEvent, NDKFilter, NDKKind, NDKSubscription } from '@nostr-dev-kit/ndk';
import { getNdk } from './ndk.js';
import { ndkEventAsSigned, type ParsedBookmark, type SignedEventLike, type UnsignedEventTemplate } from './bookmarks.js';
import { extractNostrEventRefFromUrl } from './social-refs.js';
import { isDeepmarksCollectionDTag } from '$lib/bookmark-collections.js';

/** NIP-51 bookmark-list event kinds. 10003 is a single replaceable
 *  list per user; 30003 is parametric-replaceable (one list per `d`
 *  tag, so users can have multiple named sets). 30001 is the older,
 *  now-deprecated "categorized bookmarks/sets" kind that 2023–2024
 *  clients (older Amethyst/Nostrudel) still wrote — handled like 30003
 *  so those legacy sets aren't silently dropped. */
export const BOOKMARK_LIST_KINDS = [10003, 30003, 30001] as const;
type BookmarkListKind = (typeof BOOKMARK_LIST_KINDS)[number];
export type ImportedListVisibility = 'public' | 'private';

export interface ImportedUrlBookmark extends ParsedBookmark {
  /** How this bookmark arrived — used for UI badging and for understanding
   *  which publish path to update when the user saves/unsaves from Deepmarks. */
  source: 'nip51-list';
  /** The kind of the containing list (10003 or 30003). Needed on unsave. */
  listKind: number;
  /** `d` tag on kind:30003 lists (e.g. "reading", "research"). Empty for 10003. */
  listIdentifier: string;
  /** Whether this item came from public event tags or decrypted private NIP-51 content. */
  visibility: ImportedListVisibility;
}

/** A reference to another Nostr event (most often a kind:1 note) that
 *  the list author bookmarked through a Nostr client. The target content
 *  isn't inlined — NoteCard fetches it lazily via event-resolver.ts. */
export interface ImportedNoteRef {
  /** Hex event id of the bookmarked target. */
  targetEventId: string;
  /** Pubkey of the user who bookmarked it (the list author). */
  curator: string;
  /** Stable display save time for this reference. NIP-51 carries no
   *  per-item timestamp, so we freeze the first containing-list time
   *  seen for a given target instead of letting every list republish
   *  move old items to the top. */
  savedAt: number;
  /** created_at of the containing list. Used only to decide whether
   *  a later replaceable list event should update metadata. */
  listCreatedAt: number;
  /** Event id of the containing kind:10003/30003 list. */
  listEventId: string;
  listKind: number;
  listIdentifier: string;
  source: 'nip51-list';
  /** Whether this item came from public event tags or decrypted private NIP-51 content. */
  visibility: ImportedListVisibility;
  /** Relay hints from e-tags or nevent refs; sent to the server after local decrypt. */
  relayHints?: string[];
}

export function isImportedUrlBookmark(bookmark: ParsedBookmark): bookmark is ImportedUrlBookmark {
  const candidate = bookmark as Partial<ImportedUrlBookmark>;
  return candidate.source === 'nip51-list' &&
    (candidate.listKind === 10003 || candidate.listKind === 30003 || candidate.listKind === 30001) &&
    typeof candidate.listIdentifier === 'string';
}

/**
 * Pure extractor: walk one kind:10003/30003 event and yield a synthetic
 * ParsedBookmark for every `r` tag. NIP-51 r-tags do not carry a
 * per-item saved timestamp, so the containing list's created_at is the
 * first-seen fallback and the live feed freezes that per target for
 * stable ordering across later list republishes.
 */
export function extractImportedUrls(
  event: SignedEventLike,
  tags: string[][] = event.tags,
  visibility: ImportedListVisibility = 'public',
): ImportedUrlBookmark[] {
  if (!BOOKMARK_LIST_KINDS.includes(event.kind as BookmarkListKind)) return [];

  const listIdentifier = event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
  if (isDeepmarksCollectionDTag(listIdentifier)) return [];
  const out: ImportedUrlBookmark[] = [];

  for (const tag of tags) {
    if (tag[0] !== 'r') continue;
    const url = tag[1];
    if (typeof url !== 'string' || url.length === 0) continue;
    if (!/^https?:\/\//i.test(url)) continue; // ignore non-http refs (mailto:, magnet:, etc.)

    out.push({
      url,
      // NIP-51 r-tags carry no title; other clients sometimes put a label
      // in tag[2] (non-standard but we tolerate it). Fall back to the URL.
      title: (typeof tag[2] === 'string' && tag[2].length > 0 ? tag[2] : url),
      description: '',
      tags: [],
      archivedForever: false,
      savedAt: event.created_at,
      eventCreatedAt: event.created_at,
      curator: event.pubkey,
      eventId: event.id,
      source: 'nip51-list',
      listKind: event.kind,
      listIdentifier,
      visibility,
    });
  }
  return out;
}

/**
 * Pure extractor: walk one kind:10003/30003 event and yield an ImportedNoteRef
 * for every `e` tag. The target event is identified only by id here — the
 * caller uses event-resolver.ts to fetch and render the content later.
 */
export function extractImportedNoteRefs(
  event: SignedEventLike,
  tags: string[][] = event.tags,
  visibility: ImportedListVisibility = 'public',
): ImportedNoteRef[] {
  if (!BOOKMARK_LIST_KINDS.includes(event.kind as BookmarkListKind)) return [];

  const listIdentifier = event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
  if (isDeepmarksCollectionDTag(listIdentifier)) return [];
  const out: ImportedNoteRef[] = [];

  for (const tag of tags) {
    if (tag[0] === 'e') {
      const id = tag[1];
      if (typeof id !== 'string' || !/^[0-9a-f]{64}$/i.test(id)) continue;

      out.push({
        targetEventId: id.toLowerCase(),
        curator: event.pubkey,
        savedAt: event.created_at,
        listCreatedAt: event.created_at,
        listEventId: event.id,
        listKind: event.kind,
        listIdentifier,
        source: 'nip51-list',
        visibility,
        relayHints: normalizeRelayHints([tag[2]]),
      });
    } else if (tag[0] === 'r' && typeof tag[1] === 'string') {
      const ref = extractNostrEventRefFromUrl(tag[1]);
      if (!ref) continue;
      out.push({
        targetEventId: ref.id,
        curator: event.pubkey,
        savedAt: event.created_at,
        listCreatedAt: event.created_at,
        listEventId: event.id,
        listKind: event.kind,
        listIdentifier,
        source: 'nip51-list',
        visibility,
        relayHints: normalizeRelayHints(ref.relays),
      });
    }
  }
  return out;
}

export interface ImportedFeedOptions {
  /** Restrict to a specific author (own-bookmarks view) or leave empty for
   *  the global firehose. */
  authors?: string[];
  /** Soft limit for the initial REQ — the subscription continues past it. */
  limit?: number;
  /** Decrypt private NIP-51 content for the signed-in user's own list.
   *  Only applies when `authors` contains exactly one pubkey and the
   *  event author matches it. Public/friends/profile feeds should leave
   *  this false so we never ask the signer to decrypt someone else's data. */
  decryptPrivate?: boolean;
}

export type PrivateNip51DecryptResult =
  | { ok: true; tags: string[][] }
  | { ok: false; reason: 'empty' | 'not-owner' | 'no-signer' | 'wrong-key' | 'corrupt-json' | 'wrong-shape' };

const privateTagsCache = new Map<string, Promise<string[][] | null>>();

export function isValidNip51PrivateTags(value: unknown): value is string[][] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (tag) => Array.isArray(tag) && tag.every((cell) => typeof cell === 'string'),
  );
}

export async function tryDecryptNip51PrivateTags(
  event: SignedEventLike,
  expectedOwnerPubkey: string,
): Promise<PrivateNip51DecryptResult> {
  const owner = expectedOwnerPubkey.toLowerCase();
  if (!event.content.trim()) return { ok: false, reason: 'empty' };
  if (event.pubkey.toLowerCase() !== owner) return { ok: false, reason: 'not-owner' };
  const ndk = getNdk();
  if (!ndk.signer) return { ok: false, reason: 'no-signer' };

  const cacheKey = `${event.id}:${event.content}`;
  const cached = privateTagsCache.get(cacheKey);
  if (cached) {
    const tags = await cached;
    return tags ? { ok: true, tags } : { ok: false, reason: 'wrong-key' };
  }

  const promise = decryptPrivateTagsWithFallback(event, owner);
  privateTagsCache.set(cacheKey, promise);
  const tags = await promise;
  if (!tags) privateTagsCache.delete(cacheKey);
  if (!tags) return { ok: false, reason: 'wrong-key' };
  return { ok: true, tags };
}

async function decryptPrivateTagsWithFallback(
  event: SignedEventLike,
  ownerPubkey: string,
): Promise<string[][] | null> {
  const ndk = getNdk();
  if (!ndk.signer) return null;
  const me = ndk.getUser({ pubkey: ownerPubkey });
  const schemes = encryptionSchemeOrder(event.content);

  for (const scheme of schemes) {
    let plaintext: string;
    try {
      plaintext = await ndk.signer.decrypt(me, event.content, scheme);
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      return null;
    }
    if (!isValidNip51PrivateTags(parsed)) return null;
    return parsed;
  }
  return null;
}

function encryptionSchemeOrder(ciphertext: string): NDKEncryptionScheme[] {
  // Legacy NIP-04 content carries ?iv=. Current NIP-51 uses NIP-44.
  return ciphertext.includes('?iv=') ? ['nip04', 'nip44'] : ['nip44', 'nip04'];
}

/**
 * Live Svelte store of ImportedUrlBookmark records. Each kind:10003/30003
 * event fans out into N records (one per valid r-tag). Dedup is keyed
 * on `(curator, url)` so re-publishing a list updates in place rather
 * than inserting duplicates.
 *
 * Kept intentionally separate from createBookmarkFeed (which handles
 * kind:39701) so the subscription filters are cheap and the merging
 * happens at the caller. A subsequent refactor could combine them,
 * but splitting now keeps each module one concern deep.
 */
export function createImportedBookmarksFeed(
  opts: ImportedFeedOptions = {},
): Readable<ImportedUrlBookmark[]> {
  return readableFromExtractor(opts, extractImportedUrlsIncludingPrivate, (b) => `${b.curator}::${b.url}`);
}

/**
 * Live Svelte store of note references (kind:1 and friends) from
 * kind:10003/30003 lists. Each e-tag entry becomes one ImportedNoteRef;
 * NoteCard consumes these and uses event-resolver to fetch the actual
 * content, hiding refs whose resolved target is not kind:1.
 */
export function createImportedNoteRefsFeed(
  opts: ImportedFeedOptions = {},
): Readable<ImportedNoteRef[]> {
  return readableFromExtractor(
    opts,
    extractImportedNoteRefsIncludingPrivate,
    (r) => `${r.curator}::${r.targetEventId}`,
  );
}

async function extractImportedUrlsIncludingPrivate(
  event: SignedEventLike,
  opts: ImportedFeedOptions,
): Promise<ImportedUrlBookmark[]> {
  const out = extractImportedUrls(event);
  const privateTags = await privateTagsForEvent(event, opts);
  if (privateTags) out.push(...extractImportedUrls(event, privateTags, 'private'));
  return out;
}

async function extractImportedNoteRefsIncludingPrivate(
  event: SignedEventLike,
  opts: ImportedFeedOptions,
): Promise<ImportedNoteRef[]> {
  const out = extractImportedNoteRefs(event);
  const privateTags = await privateTagsForEvent(event, opts);
  if (privateTags) out.push(...extractImportedNoteRefs(event, privateTags, 'private'));
  return out;
}

async function privateTagsForEvent(
  event: SignedEventLike,
  opts: ImportedFeedOptions,
): Promise<string[][] | null> {
  const owner = privateDecryptOwner(opts);
  if (!owner || event.pubkey.toLowerCase() !== owner) return null;
  if (!shouldDecryptAsThirdPartyNip51(event)) return null;
  const result = await tryDecryptNip51PrivateTags(event, owner);
  return result.ok ? result.tags : null;
}

function shouldDecryptAsThirdPartyNip51(event: SignedEventLike): boolean {
  if (event.kind === 10003) return true;
  if (event.kind !== 30003 && event.kind !== 30001) return false;
  const d = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';
  // Deepmarks private/archive/NWC chunks decrypt to app-specific nested
  // records, not NIP-51 private tag arrays. The private-bookmarks module
  // owns those; this importer handles third-party bookmark sets.
  return !d.startsWith('deepmarks-');
}

function privateDecryptOwner(opts: ImportedFeedOptions): string | null {
  if (!opts.decryptPrivate) return null;
  if (!opts.authors || opts.authors.length !== 1) return null;
  const owner = opts.authors[0]?.toLowerCase();
  return owner && /^[0-9a-f]{64}$/.test(owner) ? owner : null;
}

export async function buildRemoveImportedUrlBookmarkEvent(
  bookmark: ImportedUrlBookmark,
  ownerPubkey: string,
): Promise<UnsignedEventTemplate> {
  const ndk = getNdk();
  const filter: NDKFilter = {
    kinds: [bookmark.listKind as unknown as NDKKind],
    authors: [ownerPubkey],
    limit: 20,
  };
  // 30003 and 30001 are parametric-replaceable (one event per `d`); 10003
  // is a single replaceable list with no `d`. Match the `d` for both
  // parametric kinds so the right named set is edited.
  const isParametric = bookmark.listKind === 30003 || bookmark.listKind === 30001;
  if (isParametric) {
    (filter as NDKFilter & { '#d'?: string[] })['#d'] = [bookmark.listIdentifier];
  }
  const events = Array.from(await ndk.fetchEvents(filter))
    .map((event) => ndkEventAsSigned(event))
    .filter((event) => {
      if (event.kind !== bookmark.listKind) return false;
      if (isParametric) {
        return (event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '') === bookmark.listIdentifier;
      }
      return true;
    })
    .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));

  const latest = events[0];
  if (!latest) throw new Error('could not find the original NIP-51 bookmark list');

  const tags = latest.tags.filter((tag) => !(tag[0] === 'r' && tag[1] === bookmark.url));
  if (tags.length === latest.tags.length) {
    throw new Error('bookmark was not found in the original NIP-51 list');
  }
  return {
    kind: bookmark.listKind,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: latest.content ?? '',
  };
}

/**
 * Shared subscription machinery. Extracted so the URL and note-ref feeds
 * don't duplicate the NDK wiring. Each feed uses its own extractor +
 * dedup key; everything else is identical.
 */
type ImportedFeedItem = {
  savedAt: number;
  savedAtMs?: number;
  eventCreatedAt?: number;
  listCreatedAt?: number;
  eventId?: string;
  listEventId?: string;
};

function readableFromExtractor<T extends ImportedFeedItem>(
  opts: ImportedFeedOptions,
  extract: (event: SignedEventLike, opts: ImportedFeedOptions) => T[] | Promise<T[]>,
  dedupKey: (item: T) => string,
): Readable<T[]> {
  return readable<T[]>([], (set) => {
    const ndk = getNdk();
    let active = true;
    const byKey = new Map<string, T>();
    const stableStorageKey = stableImportedTimesStorageKey(opts.authors);
    const stableSavedAt = loadStableImportedTimes(stableStorageKey);

    const filter: NDKFilter = {
      kinds: BOOKMARK_LIST_KINDS as unknown as NDKKind[],
      limit: opts.limit ?? 200,
    };
    if (opts.authors?.length) filter.authors = opts.authors;

    async function absorb(event: SignedEventLike): Promise<void> {
      const items = await extract(event, opts);
      if (!active) return;
      if (items.length === 0) return;
      // NIP-51 lists are replaceable. When a newer event arrives, we
      // should drop any entries from the same curator that AREN'T in
      // the new list. Implementing that cleanly would require per-
      // (curator, listKind, listId) bookkeeping — defer; for MVP the
      // per-(curator, target) dedup key prevents duplicate rows and
      // we prefer the freshest containing list event for metadata,
      // while keeping the first savedAt we saw for stable ordering.
      let stableDirty = false;
      for (const item of items) {
        const k = dedupKey(item);
        const stable = stableSavedAt.get(k);
        const stabilized = stable && stable > 0
          ? ({ ...item, savedAt: stable } as T)
          : item;
        if (!stable || stable <= 0) {
          stableSavedAt.set(k, item.savedAt);
          stableDirty = true;
        }
        const existing = byKey.get(k);
        const merged = mergeImportedReplacement(existing, stabilized);
        if (merged) {
          byKey.set(k, merged);
        }
      }
      if (stableDirty) saveStableImportedTimes(stableStorageKey, stableSavedAt);
      set(Array.from(byKey.values()).sort((a, b) => compareImportedItems(a, b, dedupKey)));
    }

    let sub: NDKSubscription | null = null;
    try {
      sub = ndk.subscribe(filter, { closeOnEose: false });
      sub.on('event', (event: NDKEvent) => {
        void absorb(ndkEventAsSigned(event));
      });
    } catch (err) {
      // NDK pool not connected yet — the caller's re-subscription recreates us.
      // eslint-disable-next-line no-console
      console.warn('imported-bookmarks feed subscription failed:', err);
    }

    return () => {
      active = false;
      sub?.stop();
    };
  });
}

export function importedReplaceTime(item: ImportedFeedItem): number {
  return item.eventCreatedAt ?? item.listCreatedAt ?? item.savedAt;
}

export function mergeImportedReplacement<T extends ImportedFeedItem>(
  existing: T | undefined,
  incoming: T,
): T | null {
  if (!existing) return incoming;
  const incomingReplaceTime = importedReplaceTime(incoming);
  const existingReplaceTime = importedReplaceTime(existing);
  if (incomingReplaceTime < existingReplaceTime) return null;
  // NIP-01 tie-break: LOWEST id wins on equal created_at — drop the
  // incoming copy when its id is HIGHER (2026-08-23 review; matches
  // bookmark-merge-core and the relay's own retention rule).
  if (incomingReplaceTime === existingReplaceTime && importedEventId(incoming) > importedEventId(existing)) {
    return null;
  }
  return {
    ...incoming,
    savedAt: existing.savedAt,
    savedAtMs: existing.savedAtMs ?? incoming.savedAtMs,
  };
}

function importedEventId(item: ImportedFeedItem): string {
  return item.eventId ?? item.listEventId ?? '';
}

function compareImportedItems<T extends ImportedFeedItem>(
  a: T,
  b: T,
  dedupKey: (item: T) => string,
): number {
  const aMs = a.savedAtMs ?? a.savedAt * 1000;
  const bMs = b.savedAtMs ?? b.savedAt * 1000;
  const time = bMs - aMs;
  if (time !== 0) return time;
  const seconds = b.savedAt - a.savedAt;
  if (seconds !== 0) return seconds;
  return dedupKey(a).localeCompare(dedupKey(b));
}

function normalizeRelayHints(values: Array<string | undefined>): string[] | undefined {
  const relays = Array.from(new Set(values.flatMap((value) => {
    if (typeof value !== 'string' || !/^wss?:\/\//i.test(value)) return [];
    try {
      const url = new URL(value);
      const port = url.port ? `:${url.port}` : '';
      return [`${url.protocol}//${url.hostname.toLowerCase()}${port}${url.pathname.replace(/\/$/, '')}`];
    } catch {
      return [];
    }
  })));
  return relays.length > 0 ? relays : undefined;
}

function stableImportedTimesStorageKey(authors: string[] | undefined): string | null {
  if (!authors || authors.length !== 1 || !authors[0]) return null;
  return `deepmarks-imported-nip51-times:v1:${authors[0]}`;
}

function loadStableImportedTimes(storageKey: string | null): Map<string, number> {
  if (!storageKey || typeof localStorage === 'undefined') return new Map();
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = new Map<string, number>();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        out.set(key, value);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

function saveStableImportedTimes(storageKey: string | null, values: Map<string, number>): void {
  if (!storageKey || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(values)));
  } catch {
    // Quota/private mode — in-memory stability still holds for this session.
  }
}
