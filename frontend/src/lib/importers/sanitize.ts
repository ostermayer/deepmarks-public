// Shared post-parse sanitizer for every importer.
//
// Importers eat untrusted user files (Pinboard / Pocket / Instapaper /
// Raindrop / Netscape exports). The publish path already rejects bad
// URLs via assertSafeBookmarkUrl, but pushing N broken rows through
// only to watch them all fail is a bad UX — the user can't tell what
// happened. Filter at parse time so the import-preview UI shows a
// realistic count and the publish runs against rows that will succeed.
//
// Also defends the rest of the importer surface from huge files (cap
// total rows) and from numeric-coercion garbage (NaN/Infinity/negative
// timestamps from a malformed `time_added` column).

import type { BookmarkInput } from '$lib/nostr/bookmarks';

/** Hard cap on rows per import. 50k bookmarks is more than any
 *  realistic personal export — Pinboard's largest published account
 *  is ~30k. Past this we drop the tail and let the user re-run on
 *  the rest if they really need to. */
export const MAX_IMPORT_ROWS = 50_000;

/** Apply uniform safety rules to a parser's raw output. */
export function sanitizeImported(rows: BookmarkInput[]): BookmarkInput[] {
  const out: BookmarkInput[] = [];
  for (const row of rows) {
    if (out.length >= MAX_IMPORT_ROWS) break;
    if (!isHttpUrl(row.url)) continue;
    out.push({
      ...row,
      publishedAt: validTimestamp(row.publishedAt),
    });
  }
  return out;
}

/** True when `s` is a syntactically-valid http(s) URL. */
function isHttpUrl(s: string | undefined | null): s is string {
  if (typeof s !== 'string' || !s) return false;
  let u: URL;
  try { u = new URL(s); } catch { return false; }
  return u.protocol === 'http:' || u.protocol === 'https:';
}

/** Coerce a parsed timestamp to a sane positive integer (Unix seconds)
 *  or undefined. Rejects NaN/Infinity from `Number(badString)`, negative
 *  values, and timestamps absurdly far in the future. */
function validTimestamp(t: number | undefined): number | undefined {
  if (t === undefined) return undefined;
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return undefined;
  // Reject anything > 100 years in the future (a 13-digit ms timestamp
  // accidentally interpreted as seconds would land here).
  const HUNDRED_YEARS_FROM_NOW = Math.floor(Date.now() / 1000) + 100 * 365 * 24 * 60 * 60;
  if (t > HUNDRED_YEARS_FROM_NOW) return undefined;
  return Math.floor(t);
}
