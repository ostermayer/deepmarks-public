import type { ArchiveRecord } from '$lib/api/client';
import { config } from '$lib/config';
import {
  decryptArchiveBlob,
  getArchiveKeyMap,
  getPendingArchiveKey,
  type ArchiveKeyMap,
} from '$lib/nostr/archive-keys';
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

export function archiveBlobUrl(blobHash: string): string {
  return `${config.blossomUrl.replace(/\/$/, '')}/${encodeURIComponent(blobHash)}`;
}

export function archiveTimelineAt(rec: Pick<ArchiveRecord, 'archivedAt' | 'bookmarkSavedAt'>): number {
  return rec.bookmarkSavedAt && rec.bookmarkSavedAt > 0 ? rec.bookmarkSavedAt : rec.archivedAt;
}

export function archiveMime(rec: Pick<ArchiveRecord, 'kind' | 'contentType'>): string {
  if (rec.kind === 'video' || rec.kind === 'youtube' || rec.kind === 'media') {
    return rec.contentType?.startsWith('audio/') ? rec.contentType : 'video/x-matroska';
  }
  if (rec.contentType?.toLowerCase().startsWith('audio/')) return rec.contentType;
  if (rec.contentType?.toLowerCase().includes('application/pdf')) return 'application/pdf';
  return 'text/html;charset=utf-8';
}

export function archiveFilename(rec: Pick<ArchiveRecord, 'url' | 'blobHash' | 'archivedAt' | 'bookmarkSavedAt' | 'kind' | 'videoTitle' | 'contentType' | 'fileName'>): string {
  const timelineAt = archiveTimelineAt(rec);
  const date = timelineAt > 0
    ? new Date(timelineAt * 1000).toISOString().slice(0, 10)
    : 'archive';
  const isVideo = rec.kind === 'video' || rec.kind === 'youtube' || rec.kind === 'media';
  const isPdf = rec.contentType?.toLowerCase().includes('application/pdf');
  const isAudio = rec.contentType?.toLowerCase().startsWith('audio/');
  const stem = isVideo && rec.videoTitle
    ? rec.videoTitle
    : (isPdf || isAudio) && rec.fileName
      ? rec.fileName.replace(/\.pdf$/i, '')
      : hostOf(rec.url) || 'site';
  const ext = isVideo ? (isAudio ? audioExtension(rec.contentType) : 'mkv') : isPdf ? 'pdf' : isAudio ? audioExtension(rec.contentType) : 'html';
  return `${date}-${safeName(stem)}-${rec.blobHash.slice(0, 12)}.${ext}`;
}

export async function fetchArchiveBytes(
  rec: ArchiveRecord,
  opts: FetchArchiveOptions = {},
): Promise<Uint8Array> {
  const res = await fetch(archiveBlobUrl(rec.blobHash));
  if (!res.ok) throw new Error(`blossom fetch ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (rec.tier !== 'private') return bytes;

  if (!opts.pubkey) throw new Error('sign in to decrypt private archives');
  const keyMap = opts.archiveKeys ?? await getArchiveKeyMap(opts.pubkey);
  let key = keyMap[rec.blobHash];
  if (!key) {
    // The key map is cached for normal row rendering, but a mobile app
    // can resume with a stale in-memory map after a foreground/background
    // cycle. Force one relay read before telling the user the key is gone.
    const refreshed = await getArchiveKeyMap(opts.pubkey, { force: true });
    key = refreshed[rec.blobHash];
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
      if (await reconcileExtensionArchiveKeys()) {
        const refreshed = await getArchiveKeyMap(opts.pubkey, { force: true });
        key = refreshed[rec.blobHash];
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
    ? 'archive key is still syncing. Refresh in a minute; if it keeps happening, update or open the Deepmarks extension so it can publish the key.'
    : 'archive key is still syncing. Reopen Deepmarks on the device that saved this bookmark, then try again.';
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
