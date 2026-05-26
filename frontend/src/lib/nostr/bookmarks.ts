// Helpers for building / parsing kind:39701 (NIP-B0) public web bookmarks.
// Tag schema is the one fixed in CLAUDE.md.

import { KIND } from './kinds.js';

/** Minimum shape we read off a Nostr event — NDKEvent + nostr-tools events both satisfy. */
export interface SignedEventLike {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  sig?: string;
}

export interface UnsignedEventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface BookmarkInput {
  url: string;
  title?: string;
  description?: string;
  tags?: string[];
  publishedAt?: number;
  publishedAtMs?: number;
  /** Detected site Lightning address kept for metadata compatibility. */
  lightning?: string;
  /** SHA-256 of archived bytes. */
  blossomHash?: string;
  /** Wayback Machine snapshot URL, when one backs an archive. */
  waybackUrl?: string;
  /** Set true when the bookmark has a permanent archive. */
  archivedForever?: boolean;
}

export interface ParsedBookmark {
  url: string;
  title: string;
  description: string;
  tags: string[];
  publishedAt?: number;
  lightning?: string;
  blossomHash?: string;
  waybackUrl?: string;
  archivedForever: boolean;
  /** Wallclock time the *bookmark* was created — not the page. */
  savedAt: number;
  /** Nostr event created_at. For public replaceable events this can be
   *  newer than savedAt when an old bookmark is edited. */
  eventCreatedAt?: number;
  /** Millisecond-resolution local save time. Optional because relay/API
   *  events only carry Nostr's second-resolution created_at. Used to
   *  keep rapid same-second saves in the order the user made them. */
  savedAtMs?: number;
  /** Hex pubkey of the curator. */
  curator: string;
  /** Original event id, useful for q-tags / sharing. */
  eventId: string;
}

/** Reject anything that isn't an http(s) URL before signing. The reader
 *  in parseBookmarkEvent already filters non-http(s) on display, but
 *  letting the writer publish them anyway pollutes relays + risks
 *  third-party clients (or future versions of our reader) rendering
 *  javascript:/data: URLs as clickable hrefs. Mirrors the extension's
 *  assertSafeBookmarkUrl. */
export function assertSafeBookmarkUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new Error('Invalid URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs can be bookmarked');
  }
}

// NIP-89 client identification. Every event we publish carries this so
// other Nostr clients (Damus, Primal, Amethyst…) can attribute the
// save and link back to deepmarks.org. The third value is a coordinate
// pointing at our kind:31990 handler info event under the brand/social pubkey
// (one-time signed brand event; clients that look it up can deep-link
// kind:39701 back to deepmarks.org/preview for un-installed users).
export const NIP89_CLIENT_TAG: string[] = [
  'client',
  'Deepmarks',
  '31990:2944e915ba71cf0fc19f5dda048ce053a87c01fd7478b179330a17edca4ce2f4:deepmarks',
];

export function buildBookmarkEvent(input: BookmarkInput): UnsignedEventTemplate {
  assertSafeBookmarkUrl(input.url);
  const tags: string[][] = [
    ['d', input.url],
    ['title', input.title ?? ''],
    ['description', input.description ?? '']
  ];
  for (const t of input.tags ?? []) tags.push(['t', t]);
  if (input.publishedAt) tags.push(['published_at', String(input.publishedAt)]);
  if (
    input.publishedAtMs &&
    Number.isSafeInteger(input.publishedAtMs) &&
    input.publishedAt &&
    Math.floor(input.publishedAtMs / 1000) === input.publishedAt
  ) {
    tags.push(['published_at_ms', String(input.publishedAtMs)]);
  }
  if (input.lightning) tags.push(['lightning', input.lightning]);
  if (input.blossomHash) tags.push(['blossom', input.blossomHash]);
  if (input.waybackUrl) tags.push(['wayback', input.waybackUrl]);
  if (input.archivedForever) tags.push(['archive-tier', 'forever']);
  tags.push(NIP89_CLIENT_TAG);

  return {
    kind: KIND.webBookmark,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: ''
  };
}

export function parseUnixSecondsTag(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseUnixMillisTag(value: string | undefined, expectedSeconds: number): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed / 1000) === expectedSeconds ? parsed : undefined;
}

export function parseBookmarkEvent(event: SignedEventLike): ParsedBookmark | null {
  if (event.kind !== KIND.webBookmark) return null;
  const get = (name: string) => event.tags.find((t) => t[0] === name)?.[1];
  const url = get('d');
  if (!url) return null;
  // Reject anything that isn't an http(s) URL — javascript:, data:, file:,
  // vbscript: in the d-tag would otherwise become a clickable href in
  // every feed view (parseBookmarkEvent → BookmarkCard's `href={url}`).
  // Same-origin XSS reads the nsec out of localStorage, so this is RCE
  // on the user's account.
  try {
    const proto = new URL(url).protocol;
    if (proto !== 'http:' && proto !== 'https:') return null;
  } catch {
    return null;
  }
  const tagValues = event.tags
    .filter((t) => t[0] === 't')
    .map((t) => t[1] ?? '')
    .filter(Boolean);
  const publishedAt = parseUnixSecondsTag(get('published_at'));
  const savedAt = publishedAt ?? event.created_at;
  const publishedAtMs = parseUnixMillisTag(get('published_at_ms'), savedAt);

  return {
    url,
    title: get('title') ?? url,
    description: get('description') ?? '',
    tags: tagValues,
    publishedAt,
    lightning: get('lightning'),
    blossomHash: get('blossom'),
    waybackUrl: get('wayback'),
    archivedForever: get('archive-tier') === 'forever',
    savedAt,
    savedAtMs: publishedAtMs,
    eventCreatedAt: event.created_at,
    curator: event.pubkey,
    eventId: event.id
  };
}

export function bookmarkSortTimeMs(bookmark: ParsedBookmark): number {
  return bookmark.savedAtMs ?? bookmark.savedAt * 1000;
}

export function compareBookmarksNewest(a: ParsedBookmark, b: ParsedBookmark): number {
  const time = bookmarkSortTimeMs(b) - bookmarkSortTimeMs(a);
  if (time !== 0) return time;
  const seconds = b.savedAt - a.savedAt;
  if (seconds !== 0) return seconds;
  const ids = b.eventId.localeCompare(a.eventId);
  if (ids !== 0) return ids;
  return a.url.localeCompare(b.url);
}

export function compareBookmarksOldest(a: ParsedBookmark, b: ParsedBookmark): number {
  return compareBookmarksNewest(b, a);
}
