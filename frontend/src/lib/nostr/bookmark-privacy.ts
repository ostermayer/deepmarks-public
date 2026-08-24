import type { ParsedBookmark } from './bookmarks.js';

type VisibilityTaggedBookmark = ParsedBookmark & {
  visibility?: 'public' | 'private' | string;
};

/**
 * Deepmarks-native private entries use a `private:` synthetic id. Imported
 * NIP-51 entries, including synthesized note-ref rows, carry the origin
 * privacy as `visibility` instead.
 */
export function isPrivateBookmark(bookmark: ParsedBookmark): boolean {
  if (bookmark.eventId.startsWith('private:')) return true;
  return (bookmark as VisibilityTaggedBookmark).visibility === 'private';
}

