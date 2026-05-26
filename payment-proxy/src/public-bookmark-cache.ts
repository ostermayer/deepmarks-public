import type { Redis } from 'ioredis';
import type { Event as NostrEvent } from 'nostr-tools';

import { bookmarkEventToJson, bookmarkSortScore, type BookmarkJson } from './api-helpers.js';

const AUTHOR_ZSET_PREFIX = 'dm:public-bookmarks:author:';
const EVENT_PREFIX = 'dm:public-bookmarks:event:';
const MAX_AUTHOR_EVENTS = 2_000;

/**
 * Fast public-bookmark cache used as the first paint source for /app.
 *
 * Nostr relays remain the source of truth. This cache is a UX accelerator:
 * writes from Deepmarks clients land here immediately, and the indexer keeps
 * it warm for events that arrive through relay fanout.
 */
export async function cachePublicBookmarkEvent(redis: Redis, event: NostrEvent): Promise<void> {
  if (event.kind !== 39701) return;
  const bookmark = bookmarkEventToJson(event);
  if (!bookmark.url) return;

  const authorKey = AUTHOR_ZSET_PREFIX + event.pubkey;
  await redis
    .multi()
    .set(EVENT_PREFIX + event.id, JSON.stringify(bookmark))
    .zadd(authorKey, bookmarkSortScore(bookmark), event.id)
    .zremrangebyrank(authorKey, 0, -(MAX_AUTHOR_EVENTS + 1))
    .exec();
  // Anyone publishing a Deepmarks public bookmark is by definition a
  // Deepmarks user — register them so subsequent events flow through
  // the relay's writePolicy gate even when they come from a third-
  // party client. Lazy import to avoid a circular dep with registry's
  // Redis-type reuse path through some build configs.
  const { registerPubkey } = await import('./registry.js');
  await registerPubkey(redis, event.pubkey);
}

export async function removeCachedPublicBookmarksForDeletion(redis: Redis, event: NostrEvent): Promise<string[]> {
  if (event.kind !== 5) return [];
  const ids = new Set<string>();
  const explicitIds = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] === 'e' && typeof tag[1] === 'string' && /^[0-9a-f]{64}$/i.test(tag[1])) {
      explicitIds.add(tag[1].toLowerCase());
    }
  }

  const urls = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== 'a' || typeof tag[1] !== 'string') continue;
    const [kind, pubkey, ...rest] = tag[1].split(':');
    if (kind !== '39701' || pubkey !== event.pubkey) continue;
    const url = rest.join(':');
    if (url) urls.add(url);
  }

  const authorKey = AUTHOR_ZSET_PREFIX + event.pubkey;
  if (explicitIds.size > 0) {
    const explicit = [...explicitIds];
    const rows = await redis.mget(explicit.map((id) => EVENT_PREFIX + id));
    rows.forEach((raw, index) => {
      if (!raw) return;
      try {
        const bookmark = JSON.parse(raw) as BookmarkJson;
        const replaceTime = bookmark.eventCreatedAt ?? bookmark.savedAt;
        if (bookmark.pubkey === event.pubkey && event.created_at >= replaceTime) {
          ids.add(explicit[index]!);
        }
      } catch {
        // Ignore corrupt rows rather than letting a malformed cache
        // entry turn a delete request into a 500.
      }
    });
  }
  if (urls.size > 0) {
    const authorIds = await redis.zrevrange(authorKey, 0, MAX_AUTHOR_EVENTS - 1);
    if (authorIds.length > 0) {
      const rows = await redis.mget(authorIds.map((id) => EVENT_PREFIX + id));
      rows.forEach((raw, index) => {
        if (!raw) return;
        try {
          const bookmark = JSON.parse(raw) as BookmarkJson;
          const replaceTime = bookmark.eventCreatedAt ?? bookmark.savedAt;
          if (urls.has(bookmark.url) && event.created_at >= replaceTime) {
            ids.add(authorIds[index]!.toLowerCase());
          }
        } catch {
          // Corrupt cache rows are ignored here; normal listing already
          // tolerates them, and deleting unknown ids is harmless.
        }
      });
    }
  }

  if (ids.size === 0) return [];
  const pipeline = redis.multi();
  for (const id of ids) {
    pipeline.zrem(authorKey, id);
    pipeline.del(EVENT_PREFIX + id);
  }
  await pipeline.exec();
  return [...ids];
}

export async function listCachedPublicBookmarks(
  redis: Redis,
  authorPubkey: string,
  limit: number,
): Promise<BookmarkJson[]> {
  const ids = await redis.zrevrange(AUTHOR_ZSET_PREFIX + authorPubkey, 0, Math.max(limit * 4, limit) - 1);
  if (ids.length === 0) return [];

  const rows = await redis.mget(ids.map((id) => EVENT_PREFIX + id));
  const byUrl = new Map<string, BookmarkJson>();
  for (const raw of rows) {
    if (!raw) continue;
    let bookmark: BookmarkJson;
    try {
      bookmark = JSON.parse(raw) as BookmarkJson;
    } catch {
      continue;
    }
    if (!bookmark.url) continue;
    const existing = byUrl.get(bookmark.url);
    if (existing && existing.publishedAt === undefined && bookmark.savedAt < existing.savedAt) {
      byUrl.set(bookmark.url, withOriginalSaveTime(existing, bookmark));
      continue;
    }
    if (!existing || shouldReplace(existing, bookmark)) {
      byUrl.set(bookmark.url, mergeReplacement(existing, bookmark));
    }
  }

  return [...byUrl.values()]
    .sort((a, b) => bookmarkSortScore(b) - bookmarkSortScore(a) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

function shouldReplace(existing: BookmarkJson, incoming: BookmarkJson): boolean {
  const incomingReplaceTime = incoming.eventCreatedAt ?? incoming.savedAt;
  const existingReplaceTime = existing.eventCreatedAt ?? existing.savedAt;
  if (incomingReplaceTime > existingReplaceTime) return true;
  if (incomingReplaceTime < existingReplaceTime) return false;
  return incoming.id > existing.id;
}

function mergeReplacement(existing: BookmarkJson | undefined, incoming: BookmarkJson): BookmarkJson {
  if (existing && incoming.publishedAt === undefined && existing.savedAt < incoming.savedAt) {
    return withOriginalSaveTime(incoming, existing);
  }
  return incoming;
}

function withOriginalSaveTime(target: BookmarkJson, source: BookmarkJson): BookmarkJson {
  return {
    ...target,
    publishedAt: source.publishedAt,
    savedAt: source.savedAt,
    savedAtMs: source.savedAtMs,
  };
}
