// Raindrop.io CSV columns:
//   id, title, note, excerpt, url, folder, tags, created, cover, highlights, favorite

import type { BookmarkInput } from '$lib/nostr/bookmarks';
import { parseCsv } from './csv.js';
import { sanitizeImported } from './sanitize.js';
import type { ImportFormat } from './types.js';

function toUnix(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

export function parseRaindrop(content: string): BookmarkInput[] {
  const raw: BookmarkInput[] = parseCsv(content)
    .filter((row) => row.url)
    .map((row) => {
      const tags = (row.tags ?? '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      // Folder is also a useful tag — tack it on once.
      if (row.folder && !tags.includes(row.folder.toLowerCase())) {
        tags.push(row.folder.toLowerCase());
      }
      return {
        url: row.url!,
        title: row.title?.trim() || undefined,
        description: (row.note || row.excerpt || '').trim() || undefined,
        tags,
        publishedAt: toUnix(row.created)
      };
    });
  return sanitizeImported(raw);
}

export const raindropFormat: ImportFormat = {
  id: 'raindrop',
  label: 'Raindrop CSV',
  extension: 'csv',
  parse: parseRaindrop
};
