import type { ArchiveRecord } from '$lib/api/client';
import { config } from '$lib/config';
import { decryptArchiveBlob, getArchiveKeyMap, type ArchiveKeyMap } from '$lib/nostr/archive-keys';

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

export function archiveFilename(rec: Pick<ArchiveRecord, 'url' | 'blobHash' | 'archivedAt'>): string {
  const date = rec.archivedAt > 0
    ? new Date(rec.archivedAt * 1000).toISOString().slice(0, 10)
    : 'archive';
  return `${date}-${safeName(hostOf(rec.url) || 'site')}-${rec.blobHash.slice(0, 12)}.html`;
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
  const key = keyMap[rec.blobHash];
  if (!key) throw new Error('no decryption key in your relay set');
  return decryptArchiveBlob(bytes, key);
}

export async function downloadArchiveRecord(
  rec: ArchiveRecord,
  opts: FetchArchiveOptions = {},
): Promise<void> {
  const bytes = await fetchArchiveBytes(rec, opts);
  downloadBytes(bytes, archiveFilename(rec), 'text/html;charset=utf-8');
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
