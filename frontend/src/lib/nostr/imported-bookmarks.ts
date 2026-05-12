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
// a-tag (article) resolution is deferred to 1C.

import { readable, type Readable } from 'svelte/store';
import type { NDKEvent, NDKFilter, NDKKind, NDKSubscription } from '@nostr-dev-kit/ndk';
import { getNdk } from './ndk.js';
import type { ParsedBookmark, SignedEventLike } from './bookmarks.js';

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
  /** created_at of the containing list — treated as "saved at". */
  savedAt: number;
  /** Event id of the containing kind:10003/30003 list. */
  listEventId: string;
  listKind: number;
  listIdentifier: string;
  source: 'nip51-list';
}

/**
 * Pure extractor: walk one kind:10003/30003 event and yield a synthetic
 * ParsedBookmark for every `r` tag. Each r-tag appears as if the list
 * author had published a kind:39701 for that URL at the list's
 * created_at, so it slots into the existing feed/ranking pipeline with
 * zero code change downstream.
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
 * note content.
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

/**
 * Shared subscription machinery. Extracted so the URL and note-ref feeds
 * don't duplicate the NDK wiring. Each feed uses its own extractor +
 * dedup key; everything else is identical.
 */
function readableFromExtractor<T extends { savedAt: number }>(
  opts: ImportedFeedOptions,
  extract: (event: SignedEventLike) => T[],
  dedupKey: (item: T) => string,
): Readable<T[]> {
  return readable<T[]>([], (set) => {
    const ndk = getNdk();
    const byKey = new Map<string, T>();

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
      // we prefer the freshest savedAt for each distinct target.
      for (const item of items) {
        const k = dedupKey(item);
        const existing = byKey.get(k);
        if (!existing || item.savedAt > existing.savedAt) {
          byKey.set(k, item);
        }
      }
      set(Array.from(byKey.values()).sort((a, b) => b.savedAt - a.savedAt));
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
