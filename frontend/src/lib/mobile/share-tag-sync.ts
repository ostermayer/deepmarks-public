// Push the signed-in user's frequent tags to the iOS AppGroup so the
// Share Extension can offer autocomplete without WKWebView access or
// network calls. Frequency-ordered (most-used first); capped at 400.
//
// The share extension reads `deepmarks-user-tags-v1` from
// UserDefaults(suiteName: "group.org.deepmarks.app.shared") on each
// invocation.

import { writeUserTagsToAppGroup } from './secure-store.js';

const FLUSH_DEBOUNCE_MS = 600;
const MAX_TAGS = 400;
let lastWritten = '';
let flushTimer: ReturnType<typeof setTimeout> | null = null;

interface BookmarkWithTags {
  tags?: string[];
}

function rankTags(bookmarks: BookmarkWithTags[]): string[] {
  const counts = new Map<string, number>();
  for (const b of bookmarks) {
    if (!b.tags) continue;
    for (const raw of b.tags) {
      const tag = String(raw).trim().toLowerCase();
      if (!tag || tag.length > 48) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TAGS)
    .map(([tag]) => tag);
}

/** Recompute + push the user's tag set to AppGroup. Debounced so a
 *  burst of own-bookmarks store updates produces one native call. */
export function flushUserTagsForShareExtension(bookmarks: BookmarkWithTags[]): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const ranked = rankTags(bookmarks);
    const signature = ranked.join('');
    if (signature === lastWritten) return;
    lastWritten = signature;
    void writeUserTagsToAppGroup(ranked);
  }, FLUSH_DEBOUNCE_MS);
}
