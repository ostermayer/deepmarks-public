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
import type { NDKEvent, NDKFilter, NDKKind, NDKSubscription } from '@nostr-dev-kit/ndk';
import { getNdk } from './ndk.js';
import type { ParsedBookmark, SignedEventLike, UnsignedEventTemplate } from './bookmarks.js';

/** NIP-51 bookmark-list event kinds. 10003 is a single replaceable
 *  list per user; 30003 is parametric-replaceable (one list per `d`
 *  tag, so users can have multiple named sets). */
export const BOOKMARK_LIST_KINDS = [10003, 30003] as const;

export interface ImportedUrlBookmark extends ParsedBookmark {
  /** How this bookmark arrived — used for UI badging and for understanding
   *  which publish path to update when the user saves/unsaves from Deepmarks. */
  source: 'nip51-list';
  /** The kind of the containing list (10003 or 30003). Needed on unsave. */
  listKind: number;
  /** `d` tag on kind:30003 lists (e.g. "reading", "research"). Empty for 10003. */
  listIdentifier: string;
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
}

export function isImportedUrlBookmark(bookmark: ParsedBookmark): bookmark is ImportedUrlBookmark {
  const candidate = bookmark as Partial<ImportedUrlBookmark>;
  return candidate.source === 'nip51-list' &&
    (candidate.listKind === 10003 || candidate.listKind === 30003) &&
    typeof candidate.listIdentifier === 'string';
}

/**
 * Pure extractor: walk one kind:10003/30003 event and yield a synthetic
 * ParsedBookmark for every `r` tag. NIP-51 r-tags do not carry a
 * per-item saved timestamp, so the containing list's created_at is the
 * first-seen fallback and the live feed freezes that per target for
 * stable ordering across later list republishes.
 */
export function extractImportedUrls(event: SignedEventLike): ImportedUrlBookmark[] {
  if (!BOOKMARK_LIST_KINDS.includes(event.kind as 10003 | 30003)) return [];

  const listIdentifier = event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
  const out: ImportedUrlBookmark[] = [];

  for (const tag of event.tags) {
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
    });
  }
  return out;
}

/**
 * Pure extractor: walk one kind:10003/30003 event and yield an ImportedNoteRef
 * for every `e` tag. The target event is identified only by id here — the
 * caller uses event-resolver.ts to fetch and render the content later.
 */
export function extractImportedNoteRefs(event: SignedEventLike): ImportedNoteRef[] {
  if (!BOOKMARK_LIST_KINDS.includes(event.kind as 10003 | 30003)) return [];

  const listIdentifier = event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
  const out: ImportedNoteRef[] = [];

  for (const tag of event.tags) {
    if (tag[0] !== 'e') continue;
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
    });
  }
  return out;
}

export interface ImportedFeedOptions {
  /** Restrict to a specific author (own-bookmarks view) or leave empty for
   *  the global firehose. */
  authors?: string[];
  /** Soft limit for the initial REQ — the subscription continues past it. */
  limit?: number;
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
  return readableFromExtractor(opts, extractImportedUrls, (b) => `${b.curator}::${b.url}`);
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
    extractImportedNoteRefs,
    (r) => `${r.curator}::${r.targetEventId}`,
  );
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
  if (bookmark.listKind === 30003) {
    (filter as NDKFilter & { '#d'?: string[] })['#d'] = [bookmark.listIdentifier];
  }
  const events = Array.from(await ndk.fetchEvents(filter))
    .map((event) => event as unknown as SignedEventLike)
    .filter((event) => {
      if (event.kind !== bookmark.listKind) return false;
      if (bookmark.listKind === 30003) {
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
  extract: (event: SignedEventLike) => T[],
  dedupKey: (item: T) => string,
): Readable<T[]> {
  return readable<T[]>([], (set) => {
    const ndk = getNdk();
    const byKey = new Map<string, T>();
    const stableStorageKey = stableImportedTimesStorageKey(opts.authors);
    const stableSavedAt = loadStableImportedTimes(stableStorageKey);

    const filter: NDKFilter = {
      kinds: BOOKMARK_LIST_KINDS as unknown as NDKKind[],
      limit: opts.limit ?? 200,
    };
    if (opts.authors?.length) filter.authors = opts.authors;

    function absorb(event: SignedEventLike): void {
      const items = extract(event);
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
        absorb(event as unknown as SignedEventLike);
      });
    } catch (err) {
      // NDK pool not connected yet — the caller's re-subscription recreates us.
      // eslint-disable-next-line no-console
      console.warn('imported-bookmarks feed subscription failed:', err);
    }

    return () => {
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
  if (incomingReplaceTime === existingReplaceTime && importedEventId(incoming) < importedEventId(existing)) {
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
