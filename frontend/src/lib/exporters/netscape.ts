// Netscape HTML — the lingua franca of bookmark imports. Every browser eats
// this format, plus Pinboard / Raindrop / del.icio.us all import it.

import type { ParsedBookmark } from '$lib/nostr/bookmarks';
import type { ExportFormat } from './types.js';

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function generateNetscape(bookmarks: ParsedBookmark[]): string {
  const head = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Deepmarks export</TITLE>
<H1>Deepmarks</H1>
<DL><p>`;
  const body = bookmarks
    .map((b) => {
      const tagsAttr = b.tags.length ? ` TAGS="${escape(b.tags.join(','))}"` : '';
      const dateAttr = ` ADD_DATE="${b.savedAt}"`;
      const dd = b.description ? `\n    <DD>${escape(b.description)}` : '';
      return `    <DT><A HREF="${escape(b.url)}"${dateAttr}${tagsAttr}>${escape(b.title)}</A>${dd}`;
    })
    .join('\n');
  return `${head}\n${body}\n</DL><p>`;
}

export const netscapeExporter: ExportFormat = {
  id: 'netscape',
  label: 'Netscape HTML',
  extension: 'html',
  mime: 'text/html',
  generate: generateNetscape
};
