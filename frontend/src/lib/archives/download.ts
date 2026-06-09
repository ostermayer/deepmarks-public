import type { ArchiveRecord } from '$lib/api/client';
import { config } from '$lib/config';
import {
  decryptArchiveBlob,
  getArchiveKeyMap,
  getPendingArchiveKey,
  reconcileArchiveKeys,
  type ArchiveKeyMap,
} from '$lib/nostr/archive-keys';
import { archiveKeyForRecord } from '$lib/archives/key-health';
import { reconcileExtensionArchiveKeys } from '$lib/nostr/deepmarks-extension';
import { nativePlatform } from '$lib/native/runtime';

export interface ArchiveZipProgress {
  completed: number;
  total: number;
  url: string;
  status: 'ok' | 'failed';
  error?: string;
}

export interface ZipFile {
  path: string;
  data: Uint8Array;
}

interface FetchArchiveOptions {
  pubkey?: string | null;
  archiveKeys?: ArchiveKeyMap;
}

export type ArchiveFile = NonNullable<ArchiveRecord['files']>[number];

export function archiveBlobUrl(blobHash: string): string {
  return `${config.blossomUrl.replace(/\/$/, '')}/${encodeURIComponent(blobHash)}`;
}

export function archiveFiles(rec: ArchiveRecord): ArchiveFile[] {
  const files = (rec.files ?? [])
    .filter((file) => file.blobHash)
    .map((file) => ({
      ...file,
      url: file.url || rec.url,
    }));
  if (files.length > 0) return files;
  return [{
    role: archiveFileRole(rec),
    blobHash: rec.blobHash,
    url: rec.url,
    source: rec.source === 'wayback' || rec.source === 'rendered' || rec.source === 'file' ? rec.source : undefined,
    contentType: rec.contentType,
    fileName: rec.fileName,
    thumbHash: rec.thumbHash,
  }];
}

export function archiveFileAsRecord(rec: ArchiveRecord, file: ArchiveFile): ArchiveRecord {
  return {
    ...rec,
    blobHash: file.blobHash,
    url: file.url || rec.url,
    source: file.source ?? rec.source,
    contentType: file.contentType ?? rec.contentType,
    fileName: file.fileName ?? rec.fileName,
    thumbHash: file.thumbHash ?? rec.thumbHash,
    kind: kindForArchiveFile(file, rec.kind),
  };
}

export function archiveFileLabel(file: ArchiveFile): string {
  if (file.role === 'pdf') return 'PDF';
  if (file.role === 'html') return 'HTML';
  if (file.role === 'media') return 'media';
  return 'file';
}

export function archiveTimelineAt(rec: Pick<ArchiveRecord, 'archivedAt' | 'bookmarkSavedAt'>): number {
  return rec.bookmarkSavedAt && rec.bookmarkSavedAt > 0 ? rec.bookmarkSavedAt : rec.archivedAt;
}

export function archiveMime(rec: Pick<ArchiveRecord, 'kind' | 'contentType'>): string {
  const contentType = normalizedArchiveContentType(rec.contentType);
  if (contentType?.startsWith('video/') || contentType?.startsWith('audio/') || contentType?.startsWith('image/')) return contentType;
  if (contentType?.includes('application/pdf')) return 'application/pdf';
  if (rec.kind === 'file' && contentType && contentType !== 'text/html') return contentType;
  if (isArchiveMedia(rec)) return 'video/x-matroska';
  return 'text/html;charset=utf-8';
}

export function isArchiveMedia(rec: Pick<ArchiveRecord, 'kind' | 'contentType'>): boolean {
  const contentType = normalizedArchiveContentType(rec.contentType);
  return rec.kind === 'video'
    || rec.kind === 'youtube'
    || rec.kind === 'media'
    || contentType?.startsWith('video/') === true
    || contentType?.startsWith('audio/') === true
    || contentType?.startsWith('image/') === true;
}

export function reserveArchiveOpenWindow(rec: Pick<ArchiveRecord, 'kind' | 'contentType'>): Window | null {
  if (!isArchiveMedia(rec) || typeof window === 'undefined') return null;
  try {
    return window.open('about:blank', '_blank');
  } catch {
    return null;
  }
}

export function closeReservedArchiveWindow(win: Window | null): void {
  if (!win || win.closed) return;
  try { win.close(); } catch { /* ignore */ }
}

export function openArchiveBlobUrl(
  url: string,
  rec: Pick<ArchiveRecord, 'kind' | 'contentType'>,
  reservedWindow: Window | null = null,
  opts: { preferSameTab?: boolean } = {},
): boolean {
  if (typeof window === 'undefined') return false;
  const media = isArchiveMedia(rec);
  if (media && opts.preferSameTab && nativePlatform() !== 'web') {
    try {
      window.location.assign(url);
      return true;
    } catch {
      // Fall through to the normal open path.
    }
  }
  if (reservedWindow && !reservedWindow.closed) {
    try {
      reservedWindow.location.href = url;
      return true;
    } catch {
      // Fall through to a normal open/fallback below.
    }
  }
  try {
    if (media) {
      const opened = window.open(url, '_blank');
      if (opened) return true;
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    }
  } catch {
    // Continue to the native same-tab fallback for media archives.
  }
  if (!media || nativePlatform() === 'web') return false;
  window.location.assign(url);
  return true;
}

export function archiveFilename(rec: Pick<ArchiveRecord, 'url' | 'blobHash' | 'archivedAt' | 'bookmarkSavedAt' | 'kind' | 'videoTitle' | 'contentType' | 'fileName'>): string {
  const timelineAt = archiveTimelineAt(rec);
  const date = timelineAt > 0
    ? new Date(timelineAt * 1000).toISOString().slice(0, 10)
    : 'archive';
  const contentType = normalizedArchiveContentType(rec.contentType);
  const isMedia = isArchiveMedia(rec);
  const isPdf = contentType?.includes('application/pdf') === true;
  const isAudio = contentType?.startsWith('audio/') === true;
  const isImage = contentType?.startsWith('image/') === true;
  const isFile = rec.kind === 'file';
  const stem = isMedia && rec.videoTitle
    ? rec.videoTitle
    : (isFile || isPdf || isAudio || isImage || contentType?.startsWith('video/') === true) && rec.fileName
      ? stripKnownExtension(rec.fileName)
      : hostOf(rec.url) || 'site';
  const ext = archiveExtension(rec, contentType);
  return `${date}-${safeName(stem)}-${rec.blobHash.slice(0, 12)}.${ext}`;
}

/** Every server believed to hold this record's blob: the primary Blossom
 *  store first, then mirrors recorded at archive time (record-level and
 *  per-file BUD-04 fanout results). */
function archiveBlobSourceUrls(rec: ArchiveRecord): string[] {
  const primary = archiveBlobUrl(rec.blobHash);
  const mirrorServers = [
    ...(rec.mirrors ?? []),
    ...(rec.files ?? [])
      .filter((file) => file.blobHash === rec.blobHash)
      .flatMap((file) => file.mirrors ?? []),
  ]
    .filter((mirror) => mirror.ok && typeof mirror.url === 'string' && /^https:\/\//i.test(mirror.url))
    .map((mirror) => `${mirror.url.replace(/\/+$/, '')}/${encodeURIComponent(rec.blobHash)}`);
  return [primary, ...new Set(mirrorServers)].filter((url, i, all) => all.indexOf(url) === i);
}

async function sha256MatchesBlobHash(bytes: Uint8Array, blobHash: string): Promise<boolean> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex === blobHash.toLowerCase();
  } catch {
    return false;
  }
}

export async function fetchArchiveBytes(
  rec: ArchiveRecord,
  opts: FetchArchiveOptions = {},
): Promise<Uint8Array> {
  // Primary first, then recorded mirrors — the primary losing a blob
  // (bucket migration, eviction) must not brick viewing when the bytes
  // still exist on a mirror listed in this very record.
  const sources = archiveBlobSourceUrls(rec);
  let bytes: Uint8Array | null = null;
  let lastError: unknown = null;
  for (const [index, url] of sources.entries()) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        lastError = new Error(`blossom fetch ${res.status}`);
        continue;
      }
      const candidate = new Uint8Array(await res.arrayBuffer());
      // Mirror bytes for public blobs are content-addressed — verify
      // before trusting a third-party server. Private blobs are
      // authenticated by the GCM tag during decryption below.
      if (index > 0 && rec.tier !== 'private' && !(await sha256MatchesBlobHash(candidate, rec.blobHash))) {
        lastError = new Error('mirror returned bytes that do not match the blob hash');
        continue;
      }
      bytes = candidate;
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!bytes) {
    throw lastError instanceof Error ? lastError : new Error('blossom fetch failed');
  }
  if (rec.tier !== 'private') return bytes;

  if (!opts.pubkey) throw new Error('sign in to decrypt private archives');
  const keyMap = opts.archiveKeys ?? await getArchiveKeyMap(opts.pubkey);
  let key = archiveKeyForRecord(keyMap, rec);
  if (!key) {
    // The key map is cached for normal row rendering, but a mobile app
    // can resume with a stale in-memory map after a foreground/background
    // cycle. Force one relay read before telling the user the key is gone.
    const refreshed = await getArchiveKeyMap(opts.pubkey, { force: true });
    key = archiveKeyForRecord(refreshed, rec);
  }
  if (!key && rec.jobId) {
    // Stash fallback: the archive-key set may not have been published
    // to relays yet (large key maps used to fail silently before
    // chunking). The original AES key was stashed in localStorage
    // when the archive was enqueued — keyed by jobId. Use it
    // directly so the user can open the archive now; the next
    // reconcileArchiveKeys pass will promote the stash to the
    // relay-side set.
    const stashed = getPendingArchiveKey(rec.jobId);
    if (stashed) key = stashed;
  }
  if (!key) {
    try {
      await reconcileArchiveKeys([rec], opts.pubkey);
      const refreshed = await getArchiveKeyMap(opts.pubkey, { force: true });
      key = archiveKeyForRecord(refreshed, rec);
    } catch {
      // Opening/downloading the archive should still fall through to the
      // extension bridge and the normal missing-key message if local
      // reconciliation cannot publish right now.
    }
  }
  if (!key) {
    try {
      if (await reconcileExtensionArchiveKeys()) {
        const refreshed = await getArchiveKeyMap(opts.pubkey, { force: true });
        key = archiveKeyForRecord(refreshed, rec);
      }
    } catch {
      // Old extensions do not expose the reconcile bridge yet; fall
      // through to the normal missing-key message.
    }
  }
  if (!key) throw new Error(missingArchiveKeyMessage());
  return decryptArchiveBlob(bytes, key);
}

export async function downloadArchiveRecord(
  rec: ArchiveRecord,
  opts: FetchArchiveOptions = {},
): Promise<void> {
  const bytes = await fetchArchiveBytes(rec, opts);
  downloadBytes(bytes, archiveFilename(rec), archiveMime(rec));
}

export async function downloadArchivesZip(
  records: ArchiveRecord[],
  opts: FetchArchiveOptions & { onProgress?: (progress: ArchiveZipProgress) => void } = {},
): Promise<{ ok: number; failed: number }> {
  const needsKeys = records.some((rec) => rec.tier === 'private');
  const archiveKeys = opts.archiveKeys ?? (needsKeys && opts.pubkey ? await getArchiveKeyMap(opts.pubkey) : undefined);
  const files: ZipFile[] = [];
  const manifest: Array<{
    url: string;
    blobHash: string;
    tier: string;
    archivedAt: number;
    completedAt?: number;
    bookmarkSavedAt?: number;
    filename?: string;
    ok: boolean;
    error?: string;
  }> = [];
  const used = new Set<string>();
  let ok = 0;
  let failed = 0;

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    try {
      const bytes = await fetchArchiveBytes(rec, { ...opts, archiveKeys });
      const path = uniquePath(`archives/${String(i + 1).padStart(4, '0')}-${archiveFilename(rec)}`, used);
      files.push({ path, data: bytes });
      manifest.push({
        url: rec.url,
        blobHash: rec.blobHash,
        tier: rec.tier,
        archivedAt: rec.archivedAt,
        completedAt: rec.completedAt,
        bookmarkSavedAt: rec.bookmarkSavedAt,
        filename: path,
        ok: true,
      });
      ok++;
      opts.onProgress?.({ completed: i + 1, total: records.length, url: rec.url, status: 'ok' });
    } catch (e) {
      const error = (e as Error).message ?? 'failed';
      const path = uniquePath(`errors/${String(i + 1).padStart(4, '0')}-${safeName(hostOf(rec.url) || 'archive')}.txt`, used);
      files.push({
        path,
        data: utf8(`Failed to include archive\n\nURL: ${rec.url}\nBlob: ${rec.blobHash}\nError: ${error}\n`),
      });
      manifest.push({
        url: rec.url,
        blobHash: rec.blobHash,
        tier: rec.tier,
        archivedAt: rec.archivedAt,
        completedAt: rec.completedAt,
        bookmarkSavedAt: rec.bookmarkSavedAt,
        filename: path,
        ok: false,
        error,
      });
      failed++;
      opts.onProgress?.({ completed: i + 1, total: records.length, url: rec.url, status: 'failed', error });
    }
  }

  files.unshift({
    path: 'manifest.json',
    data: utf8(JSON.stringify({
      generatedAt: new Date().toISOString(),
      count: records.length,
      ok,
      failed,
      archives: manifest,
    }, null, 2)),
  });

  const zip = createZip(files);
  downloadBytes(zip, `deepmarks-archives-${new Date().toISOString().slice(0, 10)}.zip`, 'application/zip');
  return { ok, failed };
}

export function createZip(files: ZipFile[]): Uint8Array {
  if (files.length > 0xffff) throw new Error('too many files for browser zip export');

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = utf8(file.path);
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, file.data.byteLength, true);
    localView.setUint32(22, file.data.byteLength, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    localParts.push(local, file.data);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, file.data.byteLength, true);
    centralView.setUint32(24, file.data.byteLength, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);

    offset += local.byteLength + file.data.byteLength;
    if (offset > 0xffffffff) throw new Error('zip is too large for browser export');
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return concatBytes([...localParts, ...centralParts, end]);
}

function downloadBytes(bytes: Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function missingArchiveKeyMessage(): string {
  return nativePlatform() === 'web'
    ? 'archive key is missing on this device. Deepmarks will retry the private archive when your signer is available.'
    : 'archive key is missing on this device. Reopen Deepmarks on the device that saved this bookmark, or retry the archive.';
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

function audioExtension(contentType: string | undefined): string {
  const t = contentType?.toLowerCase() ?? '';
  if (t.includes('mp4') || t.includes('m4a')) return 'm4a';
  if (t.includes('ogg')) return 'ogg';
  if (t.includes('opus')) return 'opus';
  if (t.includes('wav')) return 'wav';
  if (t.includes('flac')) return 'flac';
  if (t.includes('aac')) return 'aac';
  return 'mp3';
}

function archiveExtension(
  rec: Pick<ArchiveRecord, 'kind' | 'contentType' | 'fileName'>,
  contentType: string | undefined,
): string {
  if (contentType?.startsWith('audio/')) return audioExtension(contentType);
  if (contentType?.startsWith('video/')) return videoExtension(contentType) ?? fileExtension(rec.fileName) ?? 'mkv';
  if (contentType?.startsWith('image/')) return imageExtension(contentType) ?? fileExtension(rec.fileName) ?? 'img';
  if (contentType?.includes('application/pdf')) return 'pdf';
  if (rec.kind === 'file') return fileExtension(rec.fileName) ?? fileExtensionForContentType(contentType) ?? 'bin';
  if (isArchiveMedia(rec)) return fileExtension(rec.fileName) ?? 'mkv';
  return 'html';
}

function archiveFileRole(rec: Pick<ArchiveRecord, 'kind' | 'contentType'>): ArchiveFile['role'] {
  const type = normalizedArchiveContentType(rec.contentType);
  if (type?.includes('application/pdf')) return 'pdf';
  if (isArchiveMedia(rec)) return 'media';
  if (rec.kind === 'file') return 'file';
  return 'html';
}

function kindForArchiveFile(file: ArchiveFile, fallback: string | undefined): string {
  if (file.role === 'media') return fallback ?? 'media';
  if (file.role === 'file' || file.role === 'pdf') return 'file';
  return fallback === 'media' || fallback === 'video' || fallback === 'youtube' || fallback === 'file'
    ? 'webpage'
    : (fallback ?? 'webpage');
}

function videoExtension(contentType: string | undefined): string | null {
  const t = contentType?.toLowerCase() ?? '';
  if (t.includes('mp4')) return 'mp4';
  if (t.includes('webm')) return 'webm';
  if (t.includes('quicktime')) return 'mov';
  if (t.includes('ogg')) return 'ogv';
  if (t.includes('matroska')) return 'mkv';
  if (t.includes('mpeg')) return 'mpeg';
  return null;
}

function imageExtension(contentType: string | undefined): string | null {
  const t = contentType?.toLowerCase() ?? '';
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if (t.includes('png')) return 'png';
  if (t.includes('webp')) return 'webp';
  if (t.includes('avif')) return 'avif';
  if (t.includes('gif')) return 'gif';
  if (t.includes('heic')) return 'heic';
  if (t.includes('heif')) return 'heif';
  if (t.includes('tiff')) return 'tiff';
  if (t.includes('svg')) return 'svg';
  return null;
}

function fileExtensionForContentType(contentType: string | undefined): string | null {
  const t = contentType?.toLowerCase() ?? '';
  if (t.includes('text/vtt')) return 'vtt';
  if (t.includes('subrip')) return 'srt';
  if (t.includes('ttml')) return 'ttml';
  if (t.includes('text/csv')) return 'csv';
  if (t.includes('markdown')) return 'md';
  if (t.includes('text/plain')) return 'txt';
  if (t.includes('json')) return 'json';
  if (t.includes('rss')) return 'rss';
  if (t.includes('atom')) return 'xml';
  if (t.includes('xml')) return 'xml';
  if (t.includes('epub')) return 'epub';
  if (t.includes('mobipocket')) return 'mobi';
  if (t.includes('amazon.ebook')) return 'azw3';
  if (t.includes('comicbook+zip')) return 'cbz';
  if (t.includes('comicbook-rar')) return 'cbr';
  if (t.includes('wordprocessingml')) return 'docx';
  if (t.includes('spreadsheetml')) return 'xlsx';
  if (t.includes('presentationml')) return 'pptx';
  if (t.includes('msword')) return 'doc';
  if (t.includes('ms-excel')) return 'xls';
  if (t.includes('ms-powerpoint')) return 'ppt';
  if (t.includes('opendocument.text')) return 'odt';
  if (t.includes('opendocument.spreadsheet')) return 'ods';
  if (t.includes('opendocument.presentation')) return 'odp';
  if (t.includes('application/rtf')) return 'rtf';
  if (t.includes('dash+xml')) return 'mpd';
  if (t.includes('mpegurl')) return 'm3u8';
  if (t.includes('scpls')) return 'pls';
  if (t.includes('zip')) return 'zip';
  if (t.includes('rar')) return 'rar';
  if (t.includes('7z')) return '7z';
  if (t.includes('gzip')) return 'gz';
  if (t.includes('x-tar')) return 'tar';
  return null;
}

function fileExtension(fileName: string | undefined): string | null {
  const match = fileName?.match(/\.([a-z0-9]{1,8})$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function stripKnownExtension(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{1,8}$/i, '');
}

function normalizedArchiveContentType(raw: string | undefined): string | undefined {
  const contentType = raw?.split(';')[0]?.trim().toLowerCase();
  return contentType || undefined;
}

function safeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'archive';
}

function uniquePath(path: string, used: Set<string>): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const dot = path.lastIndexOf('.');
  const base = dot >= 0 ? path.slice(0, dot) : path;
  const ext = dot >= 0 ? path.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}
