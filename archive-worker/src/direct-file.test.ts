import { afterEach, describe, expect, it, vi } from 'vitest';
import { RenderError } from './renderer.js';
import {
  shouldAttemptDirectFileArchive,
  shouldAttemptPdfArchive,
  tryDownloadDirectFileArchive,
  tryDownloadPdfArchive,
} from './direct-file.js';

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

  it('tries direct file fallback for renderer audio failures', () => {
    expect(shouldAttemptDirectFileArchive('https://example.com/episode.mp3')).toBe(true);
    expect(shouldAttemptDirectFileArchive('https://example.com/anything', new RenderError(
      'unsupported_content_type',
      'received audio/mpeg',
      'permanent',
    ))).toBe(true);
  });
});
