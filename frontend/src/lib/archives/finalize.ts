import { buildBookmarkEvent } from '$lib/nostr/bookmarks';
import { publishEvent } from '$lib/nostr/publish';
import { updatePrivateSetEntry } from '$lib/nostr/private-bookmarks';
import { rememberArchiveRecord } from '$lib/stores/my-archives';

export interface ArchiveDoneDetail {
  hash: string;
  wayback?: string;
}

export interface BookmarkArchiveSnapshot {
  url: string;
  title?: string;
  description?: string;
  tags: string[];
  lightning?: string;
  isPublic: boolean;
  savedAt?: number;
}

export async function finalizeBookmarkArchive(
  pubkey: string,
  bookmark: BookmarkArchiveSnapshot,
  detail: ArchiveDoneDetail,
): Promise<{ eventId: string }> {
  const input = {
    url: bookmark.url,
    title: bookmark.title,
    description: bookmark.description,
    tags: bookmark.tags,
    lightning: bookmark.lightning,
    blossomHash: detail.hash || undefined,
    waybackUrl: detail.wayback,
    archivedForever: true,
  };

  if (detail.hash) {
    rememberArchiveRecord(pubkey, {
      jobId: detail.hash,
      url: bookmark.url,
      blobHash: detail.hash,
      tier: bookmark.isPublic ? 'public' : 'private',
      source: 'app',
      archivedAt: bookmark.savedAt ?? Math.floor(Date.now() / 1000),
      completedAt: Math.floor(Date.now() / 1000),
      bookmarkSavedAt: bookmark.savedAt,
    });
  }

  if (bookmark.isPublic) {
    const result = await publishEvent(buildBookmarkEvent(input), pubkey);
    return { eventId: result.eventId };
  }

  let eventId = '';
  const { templates } = await updatePrivateSetEntry(input, pubkey);
  for (const template of templates) {
    const result = await publishEvent(template, pubkey);
    eventId = result.eventId;
  }
  return { eventId };
}
