// Instapaper CSV (the modern export). Columns vary slightly between exports;
// we read what's there and ignore the rest:
//   URL, Title, Selection, Folder, Timestamp

import type { BookmarkInput } from '$lib/nostr/bookmarks';
import { parseCsv } from './csv.js';
import { sanitizeImported } from './sanitize.js';
import type { ImportFormat } from './types.js';

function pick(row: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    if (row[k]) return row[k];
  }
  return undefined;
}

export function parseInstapaper(content: string): BookmarkInput[] {
  const out: BookmarkInput[] = [];
  for (const row of parseCsv(content)) {
    const url = pick(row, 'URL', 'Url', 'url');
    if (!url) continue;
    const folder = pick(row, 'Folder', 'folder');
    const ts = pick(row, 'Timestamp', 'timestamp', 'Time');
    out.push({
      url,
      title: pick(row, 'Title', 'title')?.trim() || undefined,
      description: pick(row, 'Selection', 'selection')?.trim() || undefined,
      tags: folder ? [folder.toLowerCase()] : [],
      publishedAt: ts && /^\d+$/.test(ts) ? Number(ts) : undefined
    });
  }
  return sanitizeImported(out);
}

export const instapaperFormat: ImportFormat = {
  id: 'instapaper',
  label: 'Instapaper CSV',
  extension: 'csv',
  parse: parseInstapaper
};
