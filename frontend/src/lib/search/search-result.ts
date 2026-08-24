// Uniform result shape rendered inside the search overlay (AppActionBar).
// Each list surface filters its own bookmarks/tags locally and maps the
// matches into these items so the overlay can show + open them without
// knowing what kind of page it sits on.
import type { ParsedBookmark } from '$lib/nostr/bookmarks';

export interface SearchResultItem {
  /** Stable key for the {#each} block. */
  id: string;
  title: string;
  /** Secondary line, e.g. "paulgraham.com · #essays". */
  subtitle?: string;
  /** Where the row opens. External URLs open in a new tab; internal
   *  routes (e.g. a tag page) client-route in place. */
  href: string;
  /** false = same-tab internal route. Defaults to true (new-tab link). */
  external?: boolean;
}

/** Cap rows shown in the overlay so a 10k-match query stays snappy and
 *  the panel doesn't grow unbounded. The full filtered list still renders
 *  on the page behind the overlay. */
export const OVERLAY_RESULT_CAP = 50;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function bookmarkToSearchResult(b: ParsedBookmark): SearchResultItem {
  const host = hostOf(b.url);
  const tags = (b.tags ?? []).slice(0, 3).map((t) => `#${t}`).join(' ');
  const subtitle = [host, tags].filter(Boolean).join(' · ');
  return {
    id: b.eventId || b.url,
    title: b.title?.trim() || b.url,
    subtitle: subtitle || undefined,
    href: b.url,
    external: true,
  };
}
