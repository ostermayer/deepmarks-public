// Raindrop.io-compatible CSV.

import type { ParsedBookmark } from '$lib/nostr/bookmarks';
import { quoteCsv } from './csv.js';
import type { ExportFormat } from './types.js';

const HEADERS = [
  'id',
  'title',
  'note',
  'excerpt',
  'url',
  'folder',
  'tags',
  'created',
  'cover',
  'highlights',
  'favorite',
] as const;

export function generateRaindrop(bookmarks: ParsedBookmark[]): string {
  const rows = bookmarks.map((b, index) =>
    [
      String(index + 1),
      b.title,
      b.description,
      '',
      b.url,
      b.tags[0] ?? '',
      b.tags.join(','),
      new Date(b.savedAt * 1000).toISOString(),
      '',
      '',
      'false',
    ].map(quoteCsv).join(',')
  );
  return [HEADERS.join(','), ...rows].join('\n');
}

export const raindropExporter: ExportFormat = {
  id: 'raindrop',
  label: 'Raindrop CSV',
  extension: 'csv',
  mime: 'text/csv',
  generate: generateRaindrop
};
