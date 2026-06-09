// Deepmarks CSV export. Kept separate from the low-level csv parser so
// round-trips preserve description, tags, saved time, and archive intent.

import type { BookmarkInput } from '$lib/nostr/bookmarks';
import { parseCsv } from './csv.js';
import { sanitizeImported } from './sanitize.js';
import type { ImportFormat } from './types.js';

function toUnix(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function toBool(raw: string | undefined): boolean {
  return /^(1|true|yes)$/i.test((raw ?? '').trim());
}

export function parseDeepmarksCsv(content: string): BookmarkInput[] {
  const rows = parseCsv(content);
  const raw: BookmarkInput[] = rows
    .filter((row) => row.url)
    .map((row) => ({
      url: row.url!,
      title: row.title?.trim() || undefined,
      description: row.description?.trim() || undefined,
      tags: (row.tags ?? '')
        .split(/\s+/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      publishedAt: toUnix(row.saved_at),
      archivedForever: toBool(row.archived_forever),
    }));
  return sanitizeImported(raw);
}

export const deepmarksCsvFormat: ImportFormat = {
  id: 'csv',
  label: 'Deepmarks CSV',
  extension: 'csv',
  parse: parseDeepmarksCsv
};
