// Pinboard JSON export. Each entry looks like:
//   { "href": "...", "description": "title", "extended": "long desc",
//     "meta": "...", "hash": "...", "time": "2024-01-01T00:00:00Z",
//     "shared": "yes"|"no", "toread": "yes"|"no", "tags": "space sep tags" }
// Note: Pinboard's "description" == title, "extended" == our description.

import type { BookmarkInput } from '$lib/nostr/bookmarks';
import { sanitizeImported } from './sanitize.js';
import { ImportError, type ImportFormat } from './types.js';

interface PinboardEntry {
  href: string;
  description?: string;
  extended?: string;
  time?: string;
  tags?: string;
}

function toUnix(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

export function parsePinboard(content: string): BookmarkInput[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (e) {
    throw new ImportError(`Not valid JSON: ${(e as Error).message}`, 'pinboard');
  }
  if (!Array.isArray(data)) {
    throw new ImportError('Expected an array at the top level', 'pinboard');
  }
  const out: BookmarkInput[] = [];
  for (const raw of data as PinboardEntry[]) {
    if (!raw.href) continue;
    const tags = (raw.tags ?? '')
      .split(/\s+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    out.push({
      url: raw.href,
      title: raw.description?.trim() || undefined,
      description: raw.extended?.trim() || undefined,
      tags,
      publishedAt: toUnix(raw.time)
    });
  }
  return sanitizeImported(out);
}

export const pinboardFormat: ImportFormat = {
  id: 'pinboard',
  label: 'Pinboard JSON',
  extension: 'json',
  parse: parsePinboard
};
