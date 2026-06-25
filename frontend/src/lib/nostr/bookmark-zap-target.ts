import type { ParsedBookmark } from './bookmarks.js';
import type { ZapAggregate } from './popularity.js';
import { extractNostrEventIdFromUrl } from './social-refs.js';

const HEX_EVENT_ID_RE = /^[0-9a-f]{64}$/;

type ZapTargetBookmark = Pick<ParsedBookmark, 'eventId'> & {
  url?: string;
  source?: string;
  sourceEventId?: string;
  totalZapSats?: number;
};

export function bookmarkZapTargetEventId(bookmark: ZapTargetBookmark): string | null {
  if (
    bookmark.source === 'nostr-note-link' &&
    bookmark.sourceEventId &&
    HEX_EVENT_ID_RE.test(bookmark.sourceEventId)
  ) {
    return bookmark.sourceEventId;
  }
  const eventIdFromUrl = bookmark.url ? extractNostrEventIdFromUrl(bookmark.url) : null;
  if (eventIdFromUrl) return eventIdFromUrl;
  return HEX_EVENT_ID_RE.test(bookmark.eventId) ? bookmark.eventId : null;
}

export function bookmarkZapSats(
  bookmark: ZapTargetBookmark,
  zapDataByEventId: Map<string, ZapAggregate> | null | undefined,
): number {
  const target = bookmarkZapTargetEventId(bookmark);
  if (target && zapDataByEventId) {
    const aggregate = zapDataByEventId.get(target);
    if (aggregate) return Math.floor(aggregate.totalMsat / 1000);
  }
  return bookmark.totalZapSats ?? 0;
}

export function bookmarkZapTargetEventIds(bookmarks: readonly ZapTargetBookmark[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const bookmark of bookmarks) {
    const id = bookmarkZapTargetEventId(bookmark);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function compareBookmarksByZapSats(
  a: ZapTargetBookmark & Pick<ParsedBookmark, 'savedAt' | 'eventId' | 'url'>,
  b: ZapTargetBookmark & Pick<ParsedBookmark, 'savedAt' | 'eventId' | 'url'>,
  zapDataByEventId: Map<string, ZapAggregate> | null | undefined,
): number {
  const sats = bookmarkZapSats(b, zapDataByEventId) - bookmarkZapSats(a, zapDataByEventId);
  if (sats !== 0) return sats;
  const savedAt = b.savedAt - a.savedAt;
  if (savedAt !== 0) return savedAt;
  const ids = b.eventId.localeCompare(a.eventId);
  if (ids !== 0) return ids;
  return a.url.localeCompare(b.url);
}

export function sortBookmarksByZapSats<T extends ZapTargetBookmark & Pick<ParsedBookmark, 'savedAt' | 'eventId' | 'url'>>(
  bookmarks: readonly T[],
  zapDataByEventId: Map<string, ZapAggregate> | null | undefined,
): T[] {
  return [...bookmarks].sort((a, b) => compareBookmarksByZapSats(a, b, zapDataByEventId));
}
