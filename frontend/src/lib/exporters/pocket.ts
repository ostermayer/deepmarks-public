// Pocket-compatible CSV. Pocket's tags column uses pipe separators.

import type { ParsedBookmark } from '$lib/nostr/bookmarks';
import { quoteCsv } from './csv.js';
import type { ExportFormat } from './types.js';

const HEADERS = ['title', 'url', 'time_added', 'tags', 'status'] as const;

export function generatePocket(bookmarks: ParsedBookmark[]): string {
  const rows = bookmarks.map((b) =>
    [
      b.title,
      b.url,
      String(b.savedAt),
      b.tags.join('|'),
      'archive',
    ].map(quoteCsv).join(',')
  );
  return [HEADERS.join(','), ...rows].join('\n');
}

export const pocketExporter: ExportFormat = {
  id: 'pocket',
  label: 'Pocket CSV',
  extension: 'csv',
  mime: 'text/csv',
  generate: generatePocket
};
