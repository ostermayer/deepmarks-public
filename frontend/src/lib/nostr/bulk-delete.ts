import type { ParsedBookmark } from './bookmarks.js';
import { publishBookmarkDeletion } from './delete.js';
import {
  buildRemoveImportedUrlBookmarkEvent,
  isImportedUrlBookmark,
} from './imported-bookmarks.js';
import { isPrivateBookmark } from './bookmark-privacy.js';
import { removeFromPrivateSet } from './private-bookmarks.js';
import { publishEventQueued } from './publish.js';
import { currentSession } from '$lib/stores/session.js';
import { forgetOwnBookmark } from '$lib/stores/own-bookmarks.js';

export interface DeleteOwnBookmarkResult {
  url: string;
  eventId: string;
}

export async function deleteOwnBookmark(bookmark: ParsedBookmark, reason = 'user-requested'): Promise<DeleteOwnBookmarkResult> {
  const session = currentSession();
  const pubkey = session.pubkey;
  if (!pubkey || !session.signer) throw new Error('connect your signer to delete');
  if (pubkey !== bookmark.curator) throw new Error('you can only delete your own bookmarks');

  let committed = false;
  const commitDeleted = (eventId: string): DeleteOwnBookmarkResult => {
    if (!committed) {
      committed = true;
      forgetOwnBookmark(bookmark.url);
    }
    return { url: bookmark.url, eventId };
  };

  if (isPrivateBookmark(bookmark)) {
    const tombstone = await removeFromPrivateSet(bookmark.url, pubkey);
    const result = await publishEventQueued(tombstone, pubkey, { failureSubject: 'private bookmark' });
    return commitDeleted(result.eventId);
  }

  if (isImportedUrlBookmark(bookmark)) {
    const template = await buildRemoveImportedUrlBookmarkEvent(bookmark, pubkey);
    const result = await publishEventQueued(template, pubkey, {
      onReadyToPost: (event) => commitDeleted(event.id),
    });
    return commitDeleted(result.eventId);
  }

  const result = await publishBookmarkDeletion({
    pubkey,
    eventId: bookmark.eventId,
    url: bookmark.url,
    reason,
    publishOptions: {
      queueBeforePost: true,
      onReadyToPost: (event) => commitDeleted(event.id),
    },
  });
  return commitDeleted(result.deletionEventId);
}

export async function deleteOwnBookmarks(bookmarks: readonly ParsedBookmark[], reason = 'bulk-cleanup'): Promise<{
  deleted: DeleteOwnBookmarkResult[];
  failed: { bookmark: ParsedBookmark; error: string }[];
}> {
  const unique = new Map<string, ParsedBookmark>();
  for (const bookmark of bookmarks) unique.set(bookmark.url, bookmark);

  const deleted: DeleteOwnBookmarkResult[] = [];
  const failed: { bookmark: ParsedBookmark; error: string }[] = [];
  for (const bookmark of unique.values()) {
    try {
      deleted.push(await deleteOwnBookmark(bookmark, reason));
    } catch (error) {
      failed.push({
        bookmark,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { deleted, failed };
}
