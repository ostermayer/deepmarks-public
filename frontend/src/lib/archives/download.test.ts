import { describe, expect, it } from 'vitest';
import { archiveFilename, createZip, type ZipFile } from './download';

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
