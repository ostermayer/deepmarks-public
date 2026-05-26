import type { ParsedBookmark } from './bookmarks.js';
import type { ZapAggregate } from './popularity.js';

const HEX_EVENT_ID_RE = /^[0-9a-f]{64}$/;

type ZapTargetBookmark = Pick<ParsedBookmark, 'eventId'> & {
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
