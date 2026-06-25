import type { PublicBookmark } from './api/client.js';
import type { ParsedBookmark } from './nostr/bookmarks.js';

export function publicBookmarkToParsed(bookmark: PublicBookmark): ParsedBookmark {
  return {
    url: bookmark.url,
    title: bookmark.title || bookmark.url,
    description: bookmark.description,
    tags: bookmark.tags,
    publishedAt: bookmark.publishedAt,
    blossomHash: bookmark.blossomHash,
    waybackUrl: bookmark.waybackUrl,
    archivedForever: bookmark.archivedForever,
    savedAt: bookmark.savedAt,
    savedAtMs: bookmark.savedAtMs,
    eventCreatedAt: bookmark.eventCreatedAt,
    curator: bookmark.pubkey,
    eventId: bookmark.id,
  };
}

export function mergePublicBookmarkLists(...lists: ParsedBookmark[][]): ParsedBookmark[] {
  const byUrl = new Map<string, ParsedBookmark>();
  for (const list of lists) {
    for (const bookmark of list) setLatestByUrl(byUrl, bookmark);
  }
  return [...byUrl.values()];
}

function setLatestByUrl(byUrl: Map<string, ParsedBookmark>, bookmark: ParsedBookmark): void {
  const existing = byUrl.get(bookmark.url);
  if (existing && existing.publishedAt === undefined && bookmark.savedAt < existing.savedAt) {
    byUrl.set(bookmark.url, {
      ...existing,
      publishedAt: bookmark.publishedAt,
      savedAt: bookmark.savedAt,
      savedAtMs: bookmark.savedAtMs,
    });
    return;
  }
  const bookmarkReplaceTime = bookmark.eventCreatedAt ?? bookmark.savedAt;
  const existingReplaceTime = existing ? (existing.eventCreatedAt ?? existing.savedAt) : -1;
  if (!existing || bookmarkReplaceTime > existingReplaceTime || (
    bookmarkReplaceTime === existingReplaceTime && bookmark.eventId > existing.eventId
  )) {
    byUrl.set(bookmark.url, mergeReplacement(existing, bookmark));
  }
}

function mergeReplacement(
  existing: ParsedBookmark | undefined,
  incoming: ParsedBookmark,
): ParsedBookmark {
  if (existing && incoming.publishedAt === undefined && existing.savedAt < incoming.savedAt) {
    return {
      ...incoming,
      publishedAt: existing.publishedAt,
      savedAt: existing.savedAt,
      savedAtMs: existing.savedAtMs,
    };
  }
  return incoming;
}
