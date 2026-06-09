import type { Redis } from 'ioredis';
import type { SimplePool, Event as NostrEvent } from 'nostr-tools';

import { bookmarkEventToJson, bookmarkSortScore, queryRelaysWithTimeout, type BookmarkJson } from './api-helpers.js';
import type { UrlMetadata } from './metadata.js';
import { cachePublicBookmarkEvent, listCachedPublicBookmarksByUrl } from './public-bookmark-cache.js';

export interface BookmarkMetadataFallbackDeps {
  redis: Redis;
  relayPool: SimplePool;
  relayUrl: string;
  logger?: {
    warn?: (...args: unknown[]) => void;
  };
}

/**
 * If a publisher blocks our metadata crawler, reuse metadata that a
 * Deepmarks/Nostr bookmark already published for the same URL. We try
 * Redis first, then our local relay, because the follows-ingester and
 * onboarding scanner proactively mirror friends' bookmark events there.
 */
export async function metadataFromBookmarkedUrl(
  deps: BookmarkMetadataFallbackDeps,
  url: string,
): Promise<UrlMetadata | null> {
  const cached = await listCachedPublicBookmarksByUrl(deps.redis, url, 25).catch(() => []);
  const cachedMeta = bestBookmarkMetadata(url, cached);
  if (cachedMeta) return cachedMeta;

  const dTags = dTagCandidates(url);
  const relayEvents = await queryRelaysWithTimeout(
    deps.relayPool,
    [deps.relayUrl],
    { kinds: [39701], '#d': dTags, limit: 50 },
    2_500,
  ).catch((err) => {
    deps.logger?.warn?.({ err, url }, 'metadata bookmark fallback relay query failed');
    return [] as NostrEvent[];
  });
  if (relayEvents.length === 0) return null;

  await Promise.allSettled(relayEvents.map((event) => cachePublicBookmarkEvent(deps.redis, event)));
  const bookmarks = relayEvents.map((event) => {
    try {
      return bookmarkEventToJson(event);
    } catch {
      return null;
    }
  }).filter((bookmark): bookmark is BookmarkJson => bookmark !== null && !!bookmark.url);

  return bestBookmarkMetadata(url, bookmarks);
}

export function metadataFromBookmark(url: string, bookmark: BookmarkJson): UrlMetadata | null {
  const title = usefulText(bookmark.title, url);
  const description = usefulText(bookmark.description, url);
  const tags = Array.from(new Set((bookmark.tags ?? [])
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => /^[a-z0-9][a-z0-9.-]{0,39}$/.test(tag))))
    .slice(0, 8);

  if (!title && !description && tags.length === 0) return null;
  return {
    url,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    suggestedTags: tags,
  };
}

function bestBookmarkMetadata(url: string, bookmarks: BookmarkJson[]): UrlMetadata | null {
  const candidates = bookmarks
    .map((bookmark) => ({
      bookmark,
      meta: metadataFromBookmark(url, bookmark),
    }))
    .filter((candidate): candidate is { bookmark: BookmarkJson; meta: UrlMetadata } => candidate.meta !== null)
    .sort((a, b) => {
      const quality = metadataQuality(b.meta) - metadataQuality(a.meta);
      if (quality !== 0) return quality;
      return bookmarkSortScore(b.bookmark) - bookmarkSortScore(a.bookmark) || b.bookmark.id.localeCompare(a.bookmark.id);
    });
  return candidates[0]?.meta ?? null;
}

function metadataQuality(meta: UrlMetadata): number {
  let score = 0;
  if (meta.title) score += 8;
  if (meta.description) score += 5;
  score += Math.min(meta.suggestedTags.length, 8);
  return score;
}

function usefulText(value: string | undefined, url: string): string | undefined {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed === url) return undefined;
  return trimmed.length > 500 ? trimmed.slice(0, 500).trim() : trimmed;
}

function dTagCandidates(rawUrl: string): string[] {
  const out = new Set<string>([rawUrl]);
  try {
    const url = new URL(rawUrl);
    if (url.pathname === '/') {
      const withoutRootSlash = `${url.protocol}//${url.host}${url.search}${url.hash}`;
      out.add(withoutRootSlash);
    } else if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      const withoutTrailingSlash = new URL(url.toString());
      withoutTrailingSlash.pathname = withoutTrailingSlash.pathname.slice(0, -1);
      out.add(withoutTrailingSlash.toString());
    } else {
      const withTrailingSlash = new URL(url.toString());
      withTrailingSlash.pathname = `${withTrailingSlash.pathname}/`;
      out.add(withTrailingSlash.toString());
    }
  } catch {
    // rawUrl already covers malformed input; metadata parsing should
    // prevent this path in production.
  }
  return [...out];
}
