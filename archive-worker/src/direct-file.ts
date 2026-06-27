import { basename, join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { RenderError } from './renderer.js';
import { assertSafePublicHttpUrl } from './safe-url.js';

// Browser UA so paywalled/OA publishers and mirrors that block crawler UAs
// still serve the file (e.g. scholarly-PDF rescues). Matches renderer.ts.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_DIRECT_FILE_BYTES = 150 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 60_000;

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv', '.mpeg', '.mpg', '.avi', '.3gp']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.heic', '.heif', '.tif', '.tiff', '.svg']);
const STREAM_MANIFEST_EXTENSIONS = new Set(['.m3u8', '.mpd', '.m3u', '.pls']);
const DIRECT_FILE_EXTENSION_CONTENT_TYPES = new Map<string, string>([
  ['.pdf', 'application/pdf'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.m4b', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/opus'],
  ['.wav', 'audio/wav'],
  ['.flac', 'audio/flac'],
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.mkv', 'video/x-matroska'],
  ['.ogv', 'video/ogg'],
  ['.mpeg', 'video/mpeg'],
  ['.mpg', 'video/mpeg'],
  ['.avi', 'video/x-msvideo'],
  ['.3gp', 'video/3gpp'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.svg', 'image/svg+xml'],
  ['.vtt', 'text/vtt'],
  ['.srt', 'application/x-subrip'],
  ['.ttml', 'application/ttml+xml'],
  ['.lrc', 'text/plain'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.json', 'application/json'],
  ['.xml', 'application/xml'],
  ['.rss', 'application/rss+xml'],
  ['.epub', 'application/epub+zip'],
  ['.mobi', 'application/x-mobipocket-ebook'],
  ['.azw', 'application/vnd.amazon.ebook'],
  ['.azw3', 'application/vnd.amazon.ebook'],
  ['.cbz', 'application/vnd.comicbook+zip'],
  ['.cbr', 'application/vnd.comicbook-rar'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.odt', 'application/vnd.oasis.opendocument.text'],
  ['.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['.odp', 'application/vnd.oasis.opendocument.presentation'],
  ['.rtf', 'application/rtf'],
  ['.zip', 'application/zip'],
  ['.rar', 'application/vnd.rar'],
  ['.7z', 'application/x-7z-compressed'],
  ['.tar', 'application/x-tar'],
  ['.gz', 'application/gzip'],
  ['.m3u8', 'application/vnd.apple.mpegurl'],
  ['.m3u', 'audio/x-mpegurl'],
  ['.pls', 'audio/x-scpls'],
  ['.mpd', 'application/dash+xml'],
]);
const DIRECT_FILE_CONTENT_TYPES = new Map<string, string>([
  ...[...DIRECT_FILE_EXTENSION_CONTENT_TYPES.values()].map((value) => [value, value] as const),
  ['application/octet-stream', 'application/octet-stream'],
  ['binary/octet-stream', 'application/octet-stream'],
  ['audio/x-m4a', 'audio/mp4'],
  ['video/x-m4v', 'video/mp4'],
  ['application/vnd.ms-word', 'application/msword'],
  ['application/x-mobipocket-ebook', 'application/x-mobipocket-ebook'],
  ['application/x-cbz', 'application/vnd.comicbook+zip'],
  ['application/x-cbr', 'application/vnd.comicbook-rar'],
  ['application/x-rar-compressed', 'application/vnd.rar'],
  ['application/x-mpegurl', 'application/vnd.apple.mpegurl'],
  ['audio/mpegurl', 'application/vnd.apple.mpegurl'],
  ['audio/x-mpegurl', 'application/vnd.apple.mpegurl'],
  ['application/mpegurl', 'application/vnd.apple.mpegurl'],
  ['application/vnd.ms-powerpoint', 'application/vnd.ms-powerpoint'],
  ['application/vnd.ms-excel', 'application/vnd.ms-excel'],
  ['application/xml', 'application/xml'],
  ['text/xml', 'application/xml'],
  ['application/rss+xml', 'application/rss+xml'],
  ['application/atom+xml', 'application/atom+xml'],
  ['application/x-subrip', 'application/x-subrip'],
  ['application/ttml+xml', 'application/ttml+xml'],
  ['text/vtt', 'text/vtt'],
  ['text/csv', 'text/csv'],
  ['text/plain', 'text/plain'],
  ['text/markdown', 'text/markdown'],
]);
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
const VIDEO_CONTENT_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/ogg',
  'video/x-matroska',
  'video/mpeg',
  'video/x-msvideo',
  'video/3gpp',
]);
const IMAGE_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/tiff',
  'image/svg+xml',
]);

export interface DirectFileArchive {
  bytes: Buffer;
  contentType: string;
  fileName?: string;
}

export interface DirectFileArchiveOnDisk {
  filePath: string;
  byteLength: number;
  contentType: string;
  fileName?: string;
  cleanup: () => Promise<void>;
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

export function isLikelyVideoUrl(raw: string): boolean {
  try {
    const pathname = new URL(raw).pathname.toLowerCase();
    return [...VIDEO_EXTENSIONS].some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

export function isLikelyImageUrl(raw: string): boolean {
  try {
    const pathname = new URL(raw).pathname.toLowerCase();
    return [...IMAGE_EXTENSIONS].some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

export function isLikelyStreamingManifestUrl(raw: string): boolean {
  try {
    const pathname = new URL(raw).pathname.toLowerCase();
    return [...STREAM_MANIFEST_EXTENSIONS].some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

export function isLikelySupportedDirectFileUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const path = url.pathname.toLowerCase();
    return [...DIRECT_FILE_EXTENSION_CONTENT_TYPES.keys()].some((ext) => path.endsWith(ext));
  } catch {
    return false;
  }
}

export function shouldAttemptDirectFileArchive(raw: string, err?: unknown): boolean {
  if (isLikelySupportedDirectFileUrl(raw)) return true;
  if (err instanceof RenderError && err.code === 'unsupported_content_type') {
    const message = err.message.toLowerCase();
    return messageHasDirectFileType(message);
  }
  const message = err instanceof Error ? err.message.toLowerCase() : String(err ?? '').toLowerCase();
  return message.includes('download is starting') ||
    messageHasDirectFileType(message);
}

export function shouldAttemptPdfArchive(raw: string, err?: unknown): boolean {
  return shouldAttemptDirectFileArchive(raw, err);
}

export async function tryDownloadDirectFileArchive(
  rawUrl: string,
  opts: { force?: boolean; maxBytes?: number } = {},
): Promise<DirectFileArchive | null> {
  if (!opts.force && !isLikelySupportedDirectFileUrl(rawUrl)) {
    return null;
  }

  let current = await assertSafePublicHttpUrl(rawUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Accept: 'application/pdf,audio/*,video/*,image/*,text/vtt,text/plain,text/csv,application/json,application/xml,application/epub+zip,application/zip,*/*;q=0.8',
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
    const shouldSniffBytes = opts.force && isGenericBinaryType(contentType);
    if (!inferredType && !shouldSniffBytes) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }

    const contentLength = parseContentLength(response.headers.get('content-length'));
    const maxBytes = opts.maxBytes ?? MAX_DIRECT_FILE_BYTES;
    if (contentLength && contentLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new RenderError(
        'file_too_large',
        `file ${contentLength} bytes exceeds ${maxBytes}`,
        'permanent',
      );
    }

    const bytes = await readResponseBody(response, maxBytes);
    const finalType = inferredType ?? sniffSupportedFileType(bytes);
    if (!finalType) return null;
    if (finalType === 'application/pdf' && !isPdfBytes(bytes) && !contentType.includes('application/pdf')) {
      return null;
    }
    return { bytes, contentType: finalType, fileName };
  }

  throw new RenderError('too_many_redirects', 'file had too many redirects', 'permanent');
}

export async function tryDownloadDirectFileArchiveToFile(
  rawUrl: string,
  opts: { force?: boolean; maxBytes?: number; tempDir?: string } = {},
): Promise<DirectFileArchiveOnDisk | null> {
  if (!opts.force && !isLikelySupportedDirectFileUrl(rawUrl)) {
    return null;
  }

  let current = await assertSafePublicHttpUrl(rawUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Accept: 'application/pdf,audio/*,video/*,image/*,text/vtt,text/plain,text/csv,application/json,application/xml,application/epub+zip,application/zip,*/*;q=0.8',
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
    const shouldSniffBytes = opts.force && isGenericBinaryType(contentType);
    if (!inferredType && !shouldSniffBytes) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }

    const maxBytes = opts.maxBytes ?? MAX_DIRECT_FILE_BYTES;
    const contentLength = parseContentLength(response.headers.get('content-length'));
    if (contentLength && contentLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new RenderError(
        'file_too_large',
        `file ${contentLength} bytes exceeds ${maxBytes}`,
        'permanent',
      );
    }

    const configuredTempRoot = process.env.MEDIA_ARCHIVE_TMPDIR?.trim();
    const tempRoot = opts.tempDir ?? (configuredTempRoot || tmpdir());
    await mkdir(tempRoot, { recursive: true });
    const workdir = await mkdtemp(join(tempRoot, 'deepmarks-direct-'));
    const outputPath = join(workdir, fileName || 'archive.bin');
    try {
      const written = await writeResponseBodyToFile(response, outputPath, maxBytes);
      const finalType = inferredType ?? sniffSupportedFileType(written.head);
      if (!finalType) {
        await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
        return null;
      }
      if (finalType === 'application/pdf' && !isPdfBytes(written.head) && !contentType.includes('application/pdf')) {
        await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
        return null;
      }
      return {
        filePath: outputPath,
        byteLength: written.byteLength,
        contentType: finalType,
        fileName,
        cleanup: async () => {
          await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
        },
      };
    } catch (err) {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  throw new RenderError('too_many_redirects', 'file had too many redirects', 'permanent');
}

export async function tryDownloadPdfArchive(
  rawUrl: string,
  opts: { force?: boolean; maxBytes?: number } = {},
): Promise<DirectFileArchive | null> {
  return tryDownloadDirectFileArchive(rawUrl, opts);
}

async function writeResponseBodyToFile(
  response: Response,
  outputPath: string,
  maxBytes: number,
): Promise<{ byteLength: number; head: Buffer }> {
  const writer = createWriteStream(outputPath, { flags: 'wx' });
  const headChunks: Buffer[] = [];
  let headBytes = 0;
  let total = 0;
  const collectHead = (chunk: Buffer): void => {
    if (headBytes >= 16_384) return;
    const take = chunk.subarray(0, Math.min(16_384 - headBytes, chunk.byteLength));
    headChunks.push(Buffer.from(take));
    headBytes += take.byteLength;
  };
  const write = async (chunk: Buffer): Promise<void> => {
    if (writer.write(chunk)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        writer.off('drain', onDrain);
        writer.off('error', onError);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      writer.once('drain', onDrain);
      writer.once('error', onError);
    });
  };

  try {
    if (!response.body) {
      const bytes = Buffer.from(await response.arrayBuffer());
      total = bytes.byteLength;
      if (total > maxBytes) {
        throw new RenderError('file_too_large', `file ${total} bytes exceeds ${maxBytes}`, 'permanent');
      }
      collectHead(bytes);
      await write(bytes);
    } else {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          total += chunk.byteLength;
          if (total > maxBytes) {
            throw new RenderError('file_too_large', `file ${total} bytes exceeds ${maxBytes}`, 'permanent');
          }
          collectHead(chunk);
          await write(chunk);
        }
      } finally {
        reader.releaseLock();
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      writer.end(() => resolve());
      writer.once('error', reject);
    }).catch(() => undefined);
  }
  return { byteLength: total, head: Buffer.concat(headChunks, headBytes) };
}

async function readResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new RenderError('file_too_large', `file ${bytes.byteLength} bytes exceeds ${maxBytes}`, 'permanent');
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
        throw new RenderError('file_too_large', `file ${total} bytes exceeds ${maxBytes}`, 'permanent');
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

function isGenericBinaryType(contentType: string): boolean {
  return !contentType ||
    contentType === 'application/octet-stream' ||
    contentType === 'binary/octet-stream' ||
    contentType === 'application/download' ||
    contentType === 'application/force-download' ||
    contentType === 'application/x-download';
}

function messageHasDirectFileType(message: string): boolean {
  if (message.includes('audio/') || message.includes('video/') || message.includes('image/')) return true;
  return [...DIRECT_FILE_CONTENT_TYPES.keys()]
    .filter((contentType) => !isGenericBinaryType(contentType))
    .some((contentType) => message.includes(contentType));
}

function sniffSupportedFileType(bytes: Buffer): string | null {
  if (isPdfBytes(bytes)) return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  const prefix6 = bytes.subarray(0, 6).toString('ascii');
  if (prefix6 === 'GIF87a' || prefix6 === 'GIF89a') return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brands = bytes.subarray(8, 32).toString('ascii');
    if (brands.includes('avif') || brands.includes('avis')) return 'image/avif';
    if (brands.includes('heic') || brands.includes('heix') || brands.includes('hevc') || brands.includes('hevx')) return 'image/heic';
    if (brands.includes('heif') || brands.includes('mif1') || brands.includes('msf1')) return 'image/heif';
    return 'video/mp4';
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return bytes.subarray(0, 4096).toString('latin1').toLowerCase().includes('webm') ? 'video/webm' : 'video/x-matroska';
  }
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return 'audio/mpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (bytes.subarray(0, 4).toString('ascii') === 'fLaC') return 'audio/flac';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  const zipPrefix = bytes.subarray(0, 4).toString('binary');
  if (zipPrefix === 'PK\x03\x04' || zipPrefix === 'PK\x05\x06' || zipPrefix === 'PK\x07\x08') return 'application/zip';
  if (bytes.subarray(0, 7).toString('binary') === 'Rar!\x1a\x07\x00' || bytes.subarray(0, 8).toString('binary') === 'Rar!\x1a\x07\x01\x00') return 'application/vnd.rar';
  if (bytes.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return 'application/x-7z-compressed';
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'application/gzip';
  return null;
}

function inferSupportedFileType(url: URL, fileName: string | undefined, contentType: string): string | null {
  const extensionType = typeFromKnownExtension(url, fileName);
  const contentTypeAlias = !isGenericBinaryType(contentType) ? DIRECT_FILE_CONTENT_TYPES.get(contentType) : undefined;
  if (extensionType && (isGenericBinaryType(contentType) || contentType === 'text/plain' || contentType === 'application/xml' || contentType === 'text/xml')) {
    return extensionType;
  }
  if (contentTypeAlias) return contentTypeAlias;
  if (contentType.includes('application/pdf') || hasExt(url, fileName, '.pdf')) return 'application/pdf';
  if (contentType.startsWith('audio/') || AUDIO_CONTENT_TYPES.has(contentType)) {
    return contentType === 'application/ogg' ? 'audio/ogg' : contentType;
  }
  if (contentType.startsWith('video/') || VIDEO_CONTENT_TYPES.has(contentType)) return contentType;
  if (contentType.startsWith('image/') || IMAGE_CONTENT_TYPES.has(contentType)) return contentType;
  const audioExt = [...AUDIO_EXTENSIONS].find((ext) => hasExt(url, fileName, ext));
  if (audioExt) {
    switch (audioExt) {
      case '.m4a': return 'audio/mp4';
      case '.m4b': return 'audio/mp4';
      case '.aac': return 'audio/aac';
      case '.ogg':
      case '.oga': return 'audio/ogg';
      case '.opus': return 'audio/opus';
      case '.wav': return 'audio/wav';
      case '.flac': return 'audio/flac';
      default: return 'audio/mpeg';
    }
  }
  const videoExt = [...VIDEO_EXTENSIONS].find((ext) => hasExt(url, fileName, ext));
  if (videoExt) {
    switch (videoExt) {
      case '.mp4':
      case '.m4v': return 'video/mp4';
      case '.mov': return 'video/quicktime';
      case '.webm': return 'video/webm';
      case '.ogv': return 'video/ogg';
      case '.mpeg':
      case '.mpg': return 'video/mpeg';
      case '.avi': return 'video/x-msvideo';
      case '.3gp': return 'video/3gpp';
      default: return 'video/x-matroska';
    }
  }
  const imageExt = [...IMAGE_EXTENSIONS].find((ext) => hasExt(url, fileName, ext));
  if (imageExt) {
    switch (imageExt) {
      case '.jpg':
      case '.jpeg': return 'image/jpeg';
      case '.png': return 'image/png';
      case '.webp': return 'image/webp';
      case '.avif': return 'image/avif';
      case '.heic': return 'image/heic';
      case '.heif': return 'image/heif';
      case '.tif':
      case '.tiff': return 'image/tiff';
      case '.svg': return 'image/svg+xml';
      default: return 'image/gif';
    }
  }
  return extensionType ?? null;
}

function typeFromKnownExtension(url: URL, fileName: string | undefined): string | null {
  for (const [ext, contentType] of DIRECT_FILE_EXTENSION_CONTENT_TYPES) {
    if (hasExt(url, fileName, ext)) return contentType;
  }
  return null;
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
