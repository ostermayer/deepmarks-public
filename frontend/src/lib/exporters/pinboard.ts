// Pinboard JSON. The schema mirrors Pinboard's own export; round-tripping
// (export → import) preserves URL, title, description, tags, and savedAt.

import type { ParsedBookmark } from '$lib/nostr/bookmarks';
import type { ExportFormat } from './types.js';

export function generatePinboard(bookmarks: ParsedBookmark[]): string {
  const out = bookmarks.map((b) => ({
    href: b.url,
    description: b.title,
    extended: b.description,
    time: new Date(b.savedAt * 1000).toISOString(),
    tags: b.tags.join(' '),
    shared: 'yes', // public-by-construction once exported
    toread: 'no'
  }));
  return JSON.stringify(out, null, 2);
}

export const pinboardExporter: ExportFormat = {
  id: 'pinboard',
  label: 'Pinboard JSON',
  extension: 'json',
  mime: 'application/json',
  generate: generatePinboard
};
