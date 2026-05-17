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

  if (input.isPublic) {
    const template = buildBookmarkEvent({ url, title, description, tags });
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
        publishedAt: undefined,
        archivedForever: false,
        savedAt: template.created_at,
        curator: input.pubkey,
        eventId: result.eventId,
      },
    };
  }

  const { templates } = await addToPrivateSet({ url, title, description, tags }, input.pubkey);
  const results = await publishAll(templates, input.pubkey);
  const eventId = results.at(-1)?.eventId ?? '';
  const warnings = new Set(results.flatMap((result) => result.warning ? [result.warning] : []));
  const savedAt = templates.reduce((latest, template) => Math.max(latest, template.created_at), 0)
    || Math.floor(Date.now() / 1000);

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
      publishedAt: undefined,
      archivedForever: false,
      savedAt,
      curator: input.pubkey,
      eventId: `private:${url}`,
    },
  };
}
