// Atom 1.0 feed generator for Deepmarks bookmark lists.
//
// We emit Atom rather than RSS 2.0 because Atom has cleaner semantics for
// our needs: stable `id`s (we use nostr: URIs), proper author structure
// (we can emit npub), unambiguous UTF-8, and first-class `category` tags
// that match our NIP-B0 `t` tag convention. All major readers understand
// both formats.
//
// Pure — no network, no I/O. Callers hand in the pre-ranked list of events
// plus feed-level metadata; we return the XML string.

import { nip19 } from 'nostr-tools';
import type { BookmarkJson } from '../api-helpers.js';

export interface FeedMeta {
  /** Feed title, e.g. "Deepmarks · Recent". */
  title: string;
  /** Canonical browser URL that this feed describes. */
  htmlUrl: string;
  /** The `rel="self"` URL of this Atom feed itself. */
  feedUrl: string;
  /** Stable identifier for the feed (a URL works). */
  id: string;
  /** Optional short description. */
  subtitle?: string;
}

/** XML-escape for character data + attributes. Handles the five mandatory refs. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Strip control characters the XML spec doesn't allow. Tab/LF/CR kept.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function isoFromUnix(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function safeNpub(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return pubkey;
  }
}

function entry(b: BookmarkJson): string {
  const updated = isoFromUnix(b.savedAt);
  const authorNpub = safeNpub(b.pubkey);
  // nostr: URI as the stable entry id. Since kind:39701 is replaceable by d-tag,
  // using the event id alone is fine even if the event gets replaced.
  const entryId = `nostr:${b.id}`;
  const lines: string[] = [
    '  <entry>',
    `    <title>${xmlEscape(b.title || b.url)}</title>`,
    `    <link href="${xmlEscape(b.url)}"/>`,
    `    <id>${xmlEscape(entryId)}</id>`,
    `    <updated>${updated}</updated>`,
    '    <author>',
    `      <name>${xmlEscape(authorNpub)}</name>`,
    '    </author>',
  ];
  if (b.description) {
    lines.push(`    <summary>${xmlEscape(b.description)}</summary>`);
  }
  for (const tag of b.tags) {
    lines.push(`    <category term="${xmlEscape(tag)}"/>`);
  }
  if (b.archivedForever) {
    lines.push('    <category term="archived-forever" label="archived forever"/>');
  }
  lines.push('  </entry>');
  return lines.join('\n');
}

export function buildAtomFeed(meta: FeedMeta, bookmarks: BookmarkJson[]): string {
  // Feed updated = freshest entry; if empty, fall back to now. Readers use
  // this to decide whether to re-poll.
  const latest = bookmarks.reduce(
    (acc, b) => (b.savedAt > acc ? b.savedAt : acc),
    0,
  );
  const updated = latest > 0 ? isoFromUnix(latest) : new Date().toISOString();

  const header = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${xmlEscape(meta.title)}</title>`,
    meta.subtitle ? `  <subtitle>${xmlEscape(meta.subtitle)}</subtitle>` : '',
    `  <link href="${xmlEscape(meta.htmlUrl)}"/>`,
    `  <link rel="self" type="application/atom+xml" href="${xmlEscape(meta.feedUrl)}"/>`,
    `  <id>${xmlEscape(meta.id)}</id>`,
    `  <updated>${updated}</updated>`,
    '  <generator uri="https://deepmarks.org">Deepmarks</generator>',
  ]
    .filter(Boolean)
    .join('\n');

  const entries = bookmarks.map(entry).join('\n');
  return `${header}\n${entries}\n</feed>\n`;
}
