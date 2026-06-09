// CSV — spreadsheet-friendly. RFC 4180-style quoting: any field with quote /
// comma / newline gets wrapped in quotes; embedded quotes are doubled.

import type { ParsedBookmark } from '$lib/nostr/bookmarks';
import type { ExportFormat } from './types.js';

const HEADERS = ['url', 'title', 'description', 'tags', 'saved_at', 'archived_forever'] as const;

export function quoteCsv(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function generateCsv(bookmarks: ParsedBookmark[]): string {
  const rows = bookmarks.map((b) =>
    [
      b.url,
      b.title,
      b.description,
      b.tags.join(' '),
      String(b.savedAt),
      b.archivedForever ? 'true' : 'false'
    ]
      .map(quoteCsv)
      .join(',')
  );
  return [HEADERS.join(','), ...rows].join('\n');
}

export const csvExporter: ExportFormat = {
  id: 'csv',
  label: 'Deepmarks CSV',
  extension: 'csv',
  mime: 'text/csv',
  generate: generateCsv
};
