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
  /** Detected site-operator Lightning address (for zap split routing). */
  lightning?: string;
  /** SHA-256 of archived bytes — present only on paid archives. */
  blossomHash?: string;
  /** Wayback Machine snapshot URL — paid archives only. */
  waybackUrl?: string;
  /** Set true when the user has paid for the forever archive tier. */
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
// pointing at our kind:31990 handler info event under the brand pubkey
// (one-time signed admin event; clients that look it up can deep-link
// kind:39701 back to deepmarks.org/preview for un-installed users).
const NIP89_CLIENT_TAG: string[] = [
  'client',
  'Deepmarks',
  '31990:7cb39c6fb61007613e90ffce2220887219d41601235ff08d09eae396a7d73800:deepmarks',
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

  return {
    url,
    title: get('title') ?? url,
    description: get('description') ?? '',
    tags: tagValues,
    publishedAt: get('published_at') ? Number(get('published_at')) : undefined,
    lightning: get('lightning'),
    blossomHash: get('blossom'),
    waybackUrl: get('wayback'),
    archivedForever: get('archive-tier') === 'forever',
    savedAt: event.created_at,
    curator: event.pubkey,
    eventId: event.id
  };
}
