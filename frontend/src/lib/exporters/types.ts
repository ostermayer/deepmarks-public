// Exporter interface — pure: ParsedBookmark[] → string. The UI handles file
// download separately so the same generators can be reused by the future
// browser extension (in-page download) and native clients (share sheet).

import type { ParsedBookmark } from '$lib/nostr/bookmarks';

export interface ExportFormat {
  id: 'netscape' | 'pinboard' | 'csv' | 'jsonl';
  label: string;
  /** Suggested filename extension, no leading dot. */
  extension: string;
  /** MIME type for download blobs. */
  mime: string;
  generate(bookmarks: ParsedBookmark[]): string;
}
