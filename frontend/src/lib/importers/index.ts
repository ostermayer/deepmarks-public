// Importer registry — single source of truth for what the picker shows.
// Detection: pick by file extension first, then content fingerprint as a
// fallback for ambiguous .json/.csv exports.

import type { ImportFormat } from './types.js';
import { netscapeFormat } from './netscape.js';
import { pinboardFormat } from './pinboard.js';
import { pocketFormat } from './pocket.js';
import { instapaperFormat } from './instapaper.js';
import { raindropFormat } from './raindrop.js';

export const importers: ImportFormat[] = [
  netscapeFormat,
  pinboardFormat,
  pocketFormat,
  instapaperFormat,
  raindropFormat
];

export function findImporter(id: string): ImportFormat | undefined {
  return importers.find((f) => f.id === id);
}

export function detectFormat(filename: string, content: string): ImportFormat | undefined {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'html' || ext === 'htm') return netscapeFormat;
  if (ext === 'json') return pinboardFormat;
  if (ext === 'csv') {
    // Sniff the header row — Pocket's first column is `title`, Instapaper's
    // is `URL`, Raindrop's is `id`.
    const firstLine = content.split(/\r?\n/, 1)[0]?.toLowerCase() ?? '';
    if (firstLine.startsWith('id,')) return raindropFormat;
    if (firstLine.startsWith('url,')) return instapaperFormat;
    if (firstLine.startsWith('title,')) return pocketFormat;
  }
  return undefined;
}

export type { ImportFormat } from './types.js';
export { ImportError } from './types.js';
