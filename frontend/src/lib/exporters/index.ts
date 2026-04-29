import type { ExportFormat } from './types.js';
import { netscapeExporter } from './netscape.js';
import { pinboardExporter } from './pinboard.js';
import { csvExporter } from './csv.js';

// jsonl is exposed separately because its input shape is different (raw
// signed events, not ParsedBookmark[]).
export { generateJsonl } from './jsonl.js';

export const exporters: ExportFormat[] = [netscapeExporter, pinboardExporter, csvExporter];

export function findExporter(id: ExportFormat['id']): ExportFormat | undefined {
  return exporters.find((e) => e.id === id);
}

export type { ExportFormat } from './types.js';

/** Trigger a browser download for a generated payload. */
export function downloadAsFile(content: string, filename: string, mime: string): void {
  if (typeof window === 'undefined') return; // SSR no-op
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
