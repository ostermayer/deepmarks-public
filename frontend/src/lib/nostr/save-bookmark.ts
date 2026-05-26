import { buildBookmarkEvent, type ParsedBookmark } from './bookmarks.js';
import { buildSocialPostEvent } from './social-post.js';
import { publishAll, publishEvent } from './publish.js';
import { addToPrivateSet } from './private-bookmarks.js';

export interface SaveBookmarkInput {
  url: string;
  title?: string;
  description?: string;
  tags: string[];
  isPublic: boolean;
  pubkey: string;
  socialPostText?: string;
  /** Original local save time. Used by the iOS share-drain so a
   *  bookmark captured yesterday but drained today still sorts under
   *  yesterday. */
  savedAtMs?: number;
  /**
   * Synchronous hook invoked with the optimistic ParsedBookmark
   * BEFORE the relay publish starts. Lets callers update their
   * own-bookmarks store immediately so the user sees the save
   * appear without waiting for the multi-second chunk publish
   * to land on the relay. The real eventId for public bookmarks
   * is still only known after publish — for the optimistic
   * version we synthesise a stable `optimistic:<url>` id that
   * upserts cleanly when the relay-delivered event arrives.
   */
  onOptimistic?: (bookmark: ParsedBookmark) => void;
}

export interface SaveBookmarkResult {
  eventId: string;
  bookmark: ParsedBookmark;
  publishRelayCount: number;
  socialRelayCount: number;
  publishWarning?: string;
  socialWarning?: string;
}

export async function saveBookmark(input: SaveBookmarkInput): Promise<SaveBookmarkResult> {
  const url = input.url.trim();
  const title = input.title?.trim() || undefined;
  const description = input.description?.trim() || undefined;
  const tags = [...input.tags];
  const savedAtMs = Number.isFinite(input.savedAtMs) && (input.savedAtMs ?? 0) > 0
    ? input.savedAtMs as number
    : Date.now();

  // Stamp the user's save time into a `published_at` tag on every save.
  // For kind:39701 (public) this keeps queued/share-extension saves
  // sorted by capture time even when the event is published later. For
  // kind:30003 (private) it's also load-bearing:
  // every entry inside a chunk shares the chunk's created_at, so
  // without an inner published_at tag, all entries inside a re-
  // published set get the same effective savedAt and re-sort
  // randomly. Saving the time into the ciphertext means every
  // device that decrypts sees a stable, device-independent value.
  const publishedAt = Math.floor(savedAtMs / 1000);
  const optimisticEventCreatedAt = Math.floor(Date.now() / 1000);

  // Fire the optimistic update BEFORE any relay round-trip. The real
  // ParsedBookmark shape is fully known from the input; the only
  // unknown is the public event id, which we synthesise as
  // `optimistic:<url>` and let upsertManyLatestByUrl reconcile when
  // the relay-delivered version arrives with the same savedAt.
  if (input.onOptimistic) {
    input.onOptimistic({
      url,
      title: title || url,
      description: description ?? '',
      tags,
      publishedAt,
      archivedForever: false,
      savedAt: publishedAt,
      eventCreatedAt: input.isPublic ? optimisticEventCreatedAt : undefined,
      savedAtMs,
      curator: input.pubkey,
      eventId: input.isPublic ? `optimistic:${url}` : `private:${url}`,
    });
  }

  if (input.isPublic) {
    const template = buildBookmarkEvent({ url, title, description, tags, publishedAt, publishedAtMs: savedAtMs });
    const result = await publishEvent(template, input.pubkey);
    let socialRelayCount = 0;
    let socialWarning: string | undefined;

    if (input.socialPostText?.trim()) {
      try {
        const noteResult = await publishEvent(
          buildSocialPostEvent({
            url,
            title,
            description,
            content: input.socialPostText,
            bookmarkEventId: result.eventId,
            bookmarkAuthor: input.pubkey,
          }),
          input.pubkey,
        );
        socialRelayCount = noteResult.relays.length;
        if (socialRelayCount === 0) socialWarning = 'bookmark saved, but no relay accepted the Nostr post';
      } catch (e) {
        socialWarning = `bookmark saved, but the Nostr post failed: ${(e as Error).message}`;
      }
    }

    return {
      eventId: result.eventId,
      publishRelayCount: result.relays.length,
      socialRelayCount,
      publishWarning: result.warning,
      socialWarning,
      bookmark: {
        url,
        title: title || url,
        description: description ?? '',
        tags,
        publishedAt,
        archivedForever: false,
        savedAt: publishedAt,
        eventCreatedAt: template.created_at,
        savedAtMs,
        curator: input.pubkey,
        eventId: result.eventId,
      },
    };
  }

  const { templates } = await addToPrivateSet(
    { url, title, description, tags, publishedAt, publishedAtMs: savedAtMs },
    input.pubkey,
  );
  const results = await publishAll(templates, input.pubkey);
  const eventId = results.at(-1)?.eventId ?? '';
  const warnings = new Set(results.flatMap((result) => result.warning ? [result.warning] : []));
  return {
    eventId,
    publishRelayCount: 0,
    socialRelayCount: 0,
    publishWarning: warnings.size > 0 ? Array.from(warnings).join('; ') : undefined,
    bookmark: {
      url,
      title: title || url,
      description: description ?? '',
      tags,
      publishedAt,
      archivedForever: false,
      savedAt: publishedAt,
      savedAtMs,
      curator: input.pubkey,
      eventId: `private:${url}`,
    },
  };
}
