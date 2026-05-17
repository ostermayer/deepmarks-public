// One-shot helper for the "mark read / mark unread" affordance on each
// bookmark row. Conceptually identical to editing the bookmark via
// BookmarkEditForm with one tag changed, but skips the whole UI so the
// row's pill can toggle in one tap.
//
// Public bookmarks: republish a kind:39701 with the new tag set.
// Private bookmarks: rewrite the user's encrypted NIP-51 set entry.

import type { ParsedBookmark } from './bookmarks.js';
import { buildBookmarkEvent } from './bookmarks.js';
import { publishEvent } from './publish.js';
import { updatePrivateSetEntry } from './private-bookmarks.js';
import { rememberOwnBookmark } from '$lib/stores/own-bookmarks';

const READ_LATER_TAG = 'toread';

export interface ToggleReadLaterResult {
  /** The optimistically-updated bookmark with the toggled tag set. The
   *  caller can rely on this synchronously — the local store is
   *  already updated by the time this returns. */
  bookmark: ParsedBookmark;
  /** Resolves when the relay publish settles. Caller can await this if
   *  they want to surface publish errors, but the UI should not block
   *  on it — the local cache is already updated. */
  publish: Promise<{ eventId: string }>;
}

/**
 * Optimistically toggles `toread` on a bookmark. The local cache is
 * updated synchronously so the row's visual state flips on the same
 * tick as the click; the actual relay publish happens in the
 * background and reverts the optimistic update if it fails. Caller
 * gets the publish promise back so it can show errors / retries
 * without blocking the UI.
 */
export function toggleReadLater(
  bookmark: ParsedBookmark,
  pubkey: string,
): ToggleReadLaterResult {
  if (bookmark.curator !== pubkey) {
    throw new Error('you can only toggle read-later on your own bookmarks');
  }
  const isPrivate = bookmark.eventId.startsWith('private:');
  const hadTag = bookmark.tags.includes(READ_LATER_TAG);
  const nextTags = hadTag
    ? bookmark.tags.filter((t) => t !== READ_LATER_TAG)
    : [...bookmark.tags, READ_LATER_TAG];

  const optimistic: ParsedBookmark = {
    ...bookmark,
    tags: nextTags,
    savedAt: Math.floor(Date.now() / 1000),
  };
  // Flip the local store NOW so the row re-renders on the same tick
  // as the click. The relay publish below is what eventually makes
  // this durable; if it fails we revert.
  rememberOwnBookmark(optimistic, !isPrivate);

  const input = {
    url: bookmark.url,
    title: bookmark.title === bookmark.url ? undefined : bookmark.title,
    description: bookmark.description,
    tags: nextTags,
    lightning: bookmark.lightning,
    blossomHash: bookmark.blossomHash,
    waybackUrl: bookmark.waybackUrl,
    archivedForever: bookmark.archivedForever,
  };

  const publish = (async () => {
    try {
      let eventId = '';
      if (isPrivate) {
        const { templates } = await updatePrivateSetEntry(input, pubkey);
        for (const template of templates) {
          const result = await publishEvent(template, pubkey);
          eventId = result.eventId;
        }
      } else {
        const template = buildBookmarkEvent(input);
        const result = await publishEvent(template, pubkey);
        eventId = result.eventId;
        // Public bookmarks get a fresh kind:39701 each time, so once
        // the publish succeeds carry the new event id into the cache
        // (private entries stay keyed by `private:<url>`).
        rememberOwnBookmark({ ...optimistic, eventId }, true);
      }
      return { eventId };
    } catch (err) {
      // Revert the optimistic flip so the row goes back to its prior
      // state instead of silently sitting in a desynced view.
      rememberOwnBookmark(bookmark, !isPrivate);
      throw err;
    }
  })();

  return { bookmark: optimistic, publish };
}
