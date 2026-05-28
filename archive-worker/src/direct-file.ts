import { basename } from 'node:path';
import { RenderError } from './renderer.js';
import { assertSafePublicHttpUrl } from './safe-url.js';

const UA = 'Deepmarks-Archive/1.0 (+https://deepmarks.org/bot)';
const MAX_DIRECT_FILE_BYTES = 150 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 60_000;

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac']);
const AUDIO_CONTENT_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/m4a',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/wave',
  'audio/x-m4a',
  'audio/x-wav',
  'application/ogg',
]);

export interface DirectFileArchive {
  bytes: Buffer;
  contentType: string;
  fileName?: string;
}

export function isLikelyPdfUrl(raw: string): boolean {
  try {
    return new URL(raw).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

export function isLikelyAudioUrl(raw: string): boolean {
  try {
    const pathname = new URL(raw).pathname.toLowerCase();
    return [...AUDIO_EXTENSIONS].some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

export function shouldAttemptDirectFileArchive(raw: string, err?: unknown): boolean {
  if (isLikelyPdfUrl(raw)) return true;
  if (isLikelyAudioUrl(raw)) return true;
  if (err instanceof RenderError && err.code === 'unsupported_content_type') {
    const message = err.message.toLowerCase();
    return message.includes('pdf') || message.includes('audio/');
  }
  const message = err instanceof Error ? err.message.toLowerCase() : String(err ?? '').toLowerCase();
  return message.includes('download is starting') ||
    message.includes('application/pdf') ||
    message.includes('audio/');
}

export function shouldAttemptPdfArchive(raw: string, err?: unknown): boolean {
  return shouldAttemptDirectFileArchive(raw, err);
}

export async function tryDownloadDirectFileArchive(
  rawUrl: string,
  opts: { force?: boolean } = {},
): Promise<DirectFileArchive | null> {
  if (!opts.force && !isLikelyPdfUrl(rawUrl) && !isLikelyAudioUrl(rawUrl)) return null;

  let current = await assertSafePublicHttpUrl(rawUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Accept: 'application/pdf,audio/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new RenderError('redirect_missing_location', 'file redirect missing location', 'permanent');
      }
      current = await assertSafePublicHttpUrl(new URL(location, current).toString());
      continue;
    }

    if (response.status >= 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new RenderError(
        'http_error',
        `file returned HTTP ${response.status}`,
        response.status >= 500 ? 'retryable' : 'permanent',
      );
    }

    const contentType = normalizeContentType(response.headers.get('content-type'));
    const fileName = filenameFromResponse(current, response.headers.get('content-disposition'));
    const inferredType = inferSupportedFileType(current, fileName, contentType);
    if (!inferredType) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }

    const contentLength = parseContentLength(response.headers.get('content-length'));
    if (contentLength && contentLength > MAX_DIRECT_FILE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new RenderError(
        'file_too_large',
        `file ${contentLength} bytes exceeds ${MAX_DIRECT_FILE_BYTES}`,
        'permanent',
      );
    }

    const bytes = await readResponseBody(response, MAX_DIRECT_FILE_BYTES);
    if (inferredType === 'application/pdf' && !isPdfBytes(bytes) && !contentType.includes('application/pdf')) {
      return null;
    }
    return { bytes, contentType: inferredType, fileName };
  }

  throw new RenderError('too_many_redirects', 'file had too many redirects', 'permanent');
}

export async function tryDownloadPdfArchive(
  rawUrl: string,
  opts: { force?: boolean } = {},
): Promise<DirectFileArchive | null> {
  return tryDownloadDirectFileArchive(rawUrl, opts);
}

async function readResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new RenderError('file_too_large', `PDF ${bytes.byteLength} bytes exceeds ${maxBytes}`, 'permanent');
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new RenderError('file_too_large', `PDF ${total} bytes exceeds ${maxBytes}`, 'permanent');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function normalizeContentType(value: string | null): string {
  return (value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isPdfBytes(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
}

function inferSupportedFileType(url: URL, fileName: string | undefined, contentType: string): string | null {
  if (contentType.includes('application/pdf') || hasExt(url, fileName, '.pdf')) return 'application/pdf';
  if (contentType.startsWith('audio/') || AUDIO_CONTENT_TYPES.has(contentType)) {
    return contentType === 'application/ogg' ? 'audio/ogg' : contentType;
  }
  const audioExt = [...AUDIO_EXTENSIONS].find((ext) => hasExt(url, fileName, ext));
  if (!audioExt) return null;
  switch (audioExt) {
    case '.m4a': return 'audio/mp4';
    case '.aac': return 'audio/aac';
    case '.ogg':
    case '.oga': return 'audio/ogg';
    case '.opus': return 'audio/opus';
    case '.wav': return 'audio/wav';
    case '.flac': return 'audio/flac';
    default: return 'audio/mpeg';
  }
}

function hasExt(url: URL, fileName: string | undefined, ext: string): boolean {
  const path = url.pathname.toLowerCase();
  return path.endsWith(ext) || (fileName?.toLowerCase().endsWith(ext) ?? false);
}

function filenameFromResponse(url: URL, disposition: string | null): string | undefined {
  const fromDisposition = disposition ? filenameFromContentDisposition(disposition) : undefined;
  let fallback: string;
  try {
    fallback = basename(decodeURIComponent(url.pathname));
  } catch {
    fallback = basename(url.pathname);
  }
  const raw = fromDisposition || fallback;
  const safe = raw.replace(/[\\/:*?"<>|]+/g, '-').trim();
  return safe || undefined;
}

function filenameFromContentDisposition(disposition: string): string | undefined {
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) {
    try { return decodeURIComponent(utf8.replace(/^"|"$/g, '')); }
    catch { return utf8.replace(/^"|"$/g, ''); }
  }
  const quoted = disposition.match(/filename="([^"]+)"/i)?.[1];
  if (quoted) return quoted;
  const plain = disposition.match(/filename=([^;]+)/i)?.[1];
  return plain?.trim().replace(/^"|"$/g, '');
}
