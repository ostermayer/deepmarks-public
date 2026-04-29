// Shared importer interface. Every parser is a pure function:
//   parse(text) → BookmarkInput[]
// No fetch, no DOM, no signer. That keeps tests trivial and makes it easy to
// share parsers later with the browser extension and native clients.

import type { BookmarkInput } from '$lib/nostr/bookmarks';

export interface ImportFormat {
  /** Stable id used for routing (e.g. 'pinboard'). */
  id: string;
  /** Human-readable label for the picker. */
  label: string;
  /** File-extension hint (without leading dot). */
  extension: 'json' | 'csv' | 'html' | 'jsonl';
  parse(content: string): BookmarkInput[];
}

export class ImportError extends Error {
  constructor(message: string, public format: string) {
    super(`[${format}] ${message}`);
    this.name = 'ImportError';
  }
}
