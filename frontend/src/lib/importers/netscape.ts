// Netscape Bookmark File Format — used by every browser export and by
// del.icio.us. The format is a loose HTML dialect; we parse with regex
// rather than dragging in a DOM polyfill so the importer stays usable in
// node tests, the browser extension, and (eventually) the native clients.

import type { BookmarkInput } from '$lib/nostr/bookmarks';
import { sanitizeImported } from './sanitize.js';
import type { ImportFormat } from './types.js';

// One <DT><A> entry per bookmark. Tags live in the TAGS attribute; some
// exports use a comma-separated list, some use a single value. Description
// lives in the immediately-following <DD> tag, when present.
const ENTRY_RE = /<DT>\s*<A([^>]+)>([\s\S]*?)<\/A>(?:\s*<DD>([\s\S]*?)(?=<DT|<\/DL|$))?/gi;

function attr(tagBlob: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i');
  const m = tagBlob.match(re);
  return m?.[1];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export function parseNetscape(content: string): BookmarkInput[] {
  const out: BookmarkInput[] = [];
  for (const match of content.matchAll(ENTRY_RE)) {
    const [, attrs, title, description] = match;
    if (!attrs) continue;
    const url = attr(attrs, 'HREF');
    if (!url) continue;
    const addDate = attr(attrs, 'ADD_DATE');
    const tagsAttr = attr(attrs, 'TAGS');
    const tags = tagsAttr
      ? tagsAttr
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
      : [];
    out.push({
      url,
      title: decodeEntities((title ?? '').trim()) || undefined,
      description: description ? decodeEntities(description.trim()) : undefined,
      tags,
      publishedAt: addDate ? Number(addDate) : undefined
    });
  }
  return sanitizeImported(out);
}

export const netscapeFormat: ImportFormat = {
  id: 'netscape',
  label: 'Netscape HTML (browser bookmarks, del.icio.us)',
  extension: 'html',
  parse: parseNetscape
};
