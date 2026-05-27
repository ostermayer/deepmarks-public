import { describe, expect, it } from 'vitest';
import { archiveFilename, archiveMime, archiveTimelineAt, createZip, isArchiveMedia, type ZipFile } from './download';

const text = new TextEncoder();

function u16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

describe('archive downloads', () => {
  it('creates stable, filesystem-safe archive filenames', () => {
    const name = archiveFilename({
      url: 'https://www.Example.com/path?q=1',
      blobHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      archivedAt: 1_700_000_000,
    });

    expect(name).toBe('2023-11-14-example.com-abcdef123456.html');
  });

  it('uses the bookmark timestamp for filenames when an archive completed later', () => {
    const rec = {
      url: 'https://video.example.com/watch',
      blobHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      archivedAt: 1_800_000_000,
      bookmarkSavedAt: 1_700_000_000,
      kind: 'video',
      videoTitle: 'Saved Video',
    };

    expect(archiveTimelineAt(rec)).toBe(1_700_000_000);
    expect(archiveFilename(rec)).toBe('2023-11-14-saved-video-abcdef123456.mkv');
  });

  it('uses PDF metadata for downloaded archive filenames and mime type', () => {
    const rec = {
      url: 'https://example.com/download?id=1',
      blobHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      archivedAt: 1_700_000_000,
      kind: 'file',
      contentType: 'application/pdf',
      fileName: 'White Paper.pdf',
    };

    expect(archiveMime(rec)).toBe('application/pdf');
    expect(archiveFilename(rec)).toBe('2023-11-14-white-paper-abcdef123456.pdf');
  });

  it('preserves video archive content types and filename extensions', () => {
    const rec = {
      url: 'https://cdn.example.com/media.bin',
      blobHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      archivedAt: 1_700_000_000,
      kind: 'media',
      contentType: 'video/mp4; charset=binary',
      fileName: 'clip.mp4',
      videoTitle: 'Launch Clip',
    };

    expect(isArchiveMedia(rec)).toBe(true);
    expect(archiveMime(rec)).toBe('video/mp4');
    expect(archiveFilename(rec)).toBe('2023-11-14-launch-clip-abcdef123456.mp4');
  });

  it('uses a filename extension for media archives when content type is missing', () => {
    const rec = {
      url: 'https://cdn.example.com/media',
      blobHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      archivedAt: 1_700_000_000,
      kind: 'media',
      fileName: 'clip.webm',
      videoTitle: 'Clip',
    };

    expect(archiveFilename(rec)).toBe('2023-11-14-clip-abcdef123456.webm');
  });

  it('creates a valid uncompressed zip container', () => {
    const files: ZipFile[] = [
      { path: 'manifest.json', data: text.encode('{"ok":true}') },
      { path: 'archives/example.html', data: text.encode('<h1>ok</h1>') },
    ];

    const zip = createZip(files);
    const eocdOffset = zip.byteLength - 22;
    const centralOffset = u32(zip, eocdOffset + 16);

    expect(u32(zip, 0)).toBe(0x04034b50);
    expect(u32(zip, centralOffset)).toBe(0x02014b50);
    expect(u32(zip, eocdOffset)).toBe(0x06054b50);
    expect(u16(zip, eocdOffset + 8)).toBe(files.length);
    expect(u16(zip, eocdOffset + 10)).toBe(files.length);
  });
});
