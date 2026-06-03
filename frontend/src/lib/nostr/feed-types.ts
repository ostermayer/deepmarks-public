export interface FeedOptions {
  /** Restrict to bookmarks signed by these pubkeys. */
  authors?: string[];
  /** Tag filter (NIP-12 #t). */
  tags?: string[];
  /** d-tag filter — kind:39701 is parameterized by URL via the `d` tag,
   *  so this restricts to one (or several) specific URLs. Used by the
   *  /app/url/[url] page to show every saver of the same link. */
  urls?: string[];
  /** Soft limit for initial load; the live feed continues past this. */
  limit?: number;
}
