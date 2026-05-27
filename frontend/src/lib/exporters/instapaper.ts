// Instapaper-compatible CSV. Instapaper has one Folder field, so we use the
// first tag there and keep the lossless tag set in Deepmarks CSV.

import type { ParsedBookmark } from '$lib/nostr/bookmarks';
import { quoteCsv } from './csv.js';
import type { ExportFormat } from './types.js';

const HEADERS = ['URL', 'Title', 'Selection', 'Folder', 'Timestamp'] as const;

export function generateInstapaper(bookmarks: ParsedBookmark[]): string {
  const rows = bookmarks.map((b) =>
    [
      b.url,
      b.title,
      b.description,
      b.tags[0] ?? '',
      String(b.savedAt),
    ].map(quoteCsv).join(',')
  );
  return [HEADERS.join(','), ...rows].join('\n');
}

export const instapaperExporter: ExportFormat = {
  id: 'instapaper',
  label: 'Instapaper CSV',
  extension: 'csv',
  mime: 'text/csv',
  generate: generateInstapaper
};
