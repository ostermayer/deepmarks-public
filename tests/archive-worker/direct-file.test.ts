import { afterEach, describe, expect, it, vi } from 'vitest';
import { RenderError } from '@src/renderer.js';
import {
  shouldAttemptDirectFileArchive,
  shouldAttemptPdfArchive,
  tryDownloadDirectFileArchive,
  tryDownloadPdfArchive,
} from '@src/direct-file.js';

describe('direct PDF archives', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads a PDF file directly and preserves a safe filename', async () => {
    const pdf = Buffer.from('%PDF-1.7\nhello\n%%EOF');
    const fetchMock = vi.fn(async () => new Response(pdf, {
      status: 200,
      headers: {
        'content-type': 'application/pdf; charset=binary',
        'content-disposition': `attachment; filename="Quarterly:Report?.pdf"`,
        'content-length': String(pdf.byteLength),
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const archive = await tryDownloadPdfArchive('https://93.184.216.34/files/report.pdf');

    expect(archive?.contentType).toBe('application/pdf');
    expect(archive?.bytes.toString('ascii')).toContain('%PDF-');
    expect(archive?.fileName).toBe('Quarterly-Report-.pdf');
  });

  it('validates redirect targets before fetching the next hop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/private.pdf' },
    })));

    await expect(tryDownloadPdfArchive('https://93.184.216.34/start.pdf')).rejects.toThrow('unsafe url');
  });

  it('tries direct PDF fallback for renderer PDF/download failures', () => {
    expect(shouldAttemptPdfArchive('https://example.com/anything', new RenderError(
      'unsupported_content_type',
      'received application/pdf',
      'permanent',
    ))).toBe(true);
    expect(shouldAttemptPdfArchive('https://example.com/anything', new Error('Download is starting'))).toBe(true);
  });

  it('downloads a podcast audio file directly', async () => {
    const mp3 = Buffer.from('ID3 podcast bytes');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(mp3, {
      status: 200,
      headers: {
        'content-type': 'audio/mpeg',
        'content-disposition': `attachment; filename="episode:42?.mp3"`,
        'content-length': String(mp3.byteLength),
      },
    })));

    const archive = await tryDownloadDirectFileArchive('https://93.184.216.34/podcast/episode.mp3');

    expect(archive?.contentType).toBe('audio/mpeg');
    expect(archive?.bytes.toString('ascii')).toContain('podcast');
    expect(archive?.fileName).toBe('episode-42-.mp3');
  });

  it('downloads a direct image file', async () => {
    const png = Buffer.from('\x89PNG\r\nimage bytes', 'binary');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-disposition': `inline; filename="cover:art?.png"`,
        'content-length': String(png.byteLength),
      },
    })));

    const archive = await tryDownloadDirectFileArchive('https://93.184.216.34/images/cover.png');

    expect(archive?.contentType).toBe('image/png');
    expect(archive?.bytes.byteLength).toBe(png.byteLength);
    expect(archive?.fileName).toBe('cover-art-.png');
  });

  it('downloads common direct document and sidecar files with preserved content types', async () => {
    const cases = [
      {
        url: 'https://93.184.216.34/docs/report.docx',
        contentType: 'application/octet-stream',
        expected: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      {
        url: 'https://93.184.216.34/books/manual.epub',
        contentType: 'application/epub+zip',
        expected: 'application/epub+zip',
      },
      {
        url: 'https://93.184.216.34/captions/episode.vtt',
        contentType: 'text/vtt',
        expected: 'text/vtt',
      },
      {
        url: 'https://93.184.216.34/live/stream.m3u8',
        contentType: 'application/vnd.apple.mpegurl',
        expected: 'application/vnd.apple.mpegurl',
      },
      {
        url: 'https://93.184.216.34/photos/raw.heic',
        contentType: 'application/octet-stream',
        expected: 'image/heic',
      },
    ];

    for (const entry of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('file bytes'), {
        status: 200,
        headers: {
          'content-type': entry.contentType,
          'content-length': String(Buffer.byteLength('file bytes')),
        },
      })));

      const archive = await tryDownloadDirectFileArchive(entry.url);

      expect(archive?.contentType).toBe(entry.expected);
      expect(archive?.bytes.toString('ascii')).toBe('file bytes');
    }
  });

  it('sniffs forced generic Blossom-style image blobs', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('image bytes'),
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(png.byteLength),
      },
    })));

    const archive = await tryDownloadDirectFileArchive(`https://93.184.216.34/${'a'.repeat(64)}`, { force: true });

    expect(archive?.contentType).toBe('image/png');
    expect(archive?.bytes.byteLength).toBe(png.byteLength);
  });

  it('tries direct file fallback for renderer audio failures', () => {
    expect(shouldAttemptDirectFileArchive('https://example.com/episode.mp3')).toBe(true);
    expect(shouldAttemptDirectFileArchive('https://example.com/image.webp')).toBe(true);
    expect(shouldAttemptDirectFileArchive('https://example.com/report.docx')).toBe(true);
    expect(shouldAttemptDirectFileArchive('https://example.com/subtitles.srt')).toBe(true);
    expect(shouldAttemptDirectFileArchive('https://example.com/stream.mpd')).toBe(true);
    expect(shouldAttemptDirectFileArchive('https://example.com/anything', new RenderError(
      'unsupported_content_type',
      'received audio/mpeg',
      'permanent',
    ))).toBe(true);
    expect(shouldAttemptDirectFileArchive('https://example.com/anything', new RenderError(
      'unsupported_content_type',
      'received application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'permanent',
    ))).toBe(true);
    expect(shouldAttemptDirectFileArchive('https://example.com/anything', new RenderError(
      'unsupported_content_type',
      'received image/webp',
      'permanent',
    ))).toBe(true);
  });
});
