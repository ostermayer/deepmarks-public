// Pocket CSV columns: title, url, time_added, tags, status
// (status = "unread" | "archive"; we ignore — bookmark-vs-archive is our concept).

import type { BookmarkInput } from '$lib/nostr/bookmarks';
import { parseCsv } from './csv.js';
import { sanitizeImported } from './sanitize.js';
import type { ImportFormat } from './types.js';

export function parsePocket(content: string): BookmarkInput[] {
  const raw: BookmarkInput[] = parseCsv(content)
    .filter((row) => row.url)
    .map((row) => ({
      url: row.url!,
      title: row.title?.trim() || undefined,
      tags: (row.tags ?? '')
        .split('|')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      publishedAt: row.time_added ? Number(row.time_added) : undefined
    }));
  return sanitizeImported(raw);
}

export const pocketFormat: ImportFormat = {
  id: 'pocket',
  label: 'Pocket CSV',
  extension: 'csv',
  parse: parsePocket
};
