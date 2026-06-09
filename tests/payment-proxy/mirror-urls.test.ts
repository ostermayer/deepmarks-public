import { describe, expect, it } from 'vitest';
import { normalizeMirrorUrls } from '@src/mirror-urls.js';

describe('normalizeMirrorUrls', () => {
  it('treats a missing mirror list as empty', () => {
    expect(normalizeMirrorUrls(undefined)).toEqual({ ok: true, urls: [] });
  });

  it('normalizes and dedupes public https Blossom origins', () => {
    expect(normalizeMirrorUrls([
      'https://blossom.example.com/path',
      'https://blossom.example.com/other',
      'https://backup.example.net',
    ])).toEqual({
      ok: true,
      urls: ['https://blossom.example.com', 'https://backup.example.net'],
    });
  });

  it('rejects non-array, non-string, insecure, and private targets', () => {
    expect(normalizeMirrorUrls('https://x')).toMatchObject({ ok: false });
    expect(normalizeMirrorUrls([123])).toMatchObject({ ok: false });
    expect(normalizeMirrorUrls(['http://blossom.example.com'])).toMatchObject({ ok: false });
    expect(normalizeMirrorUrls(['https://127.0.0.1'])).toMatchObject({ ok: false });
  });

  it('caps user-supplied backup Blossom servers', () => {
    expect(normalizeMirrorUrls(Array.from({ length: 9 }, (_, i) => `https://b${i}.example.com`)))
      .toEqual({ ok: false, error: 'mirrorUrls supports up to 8 backup Blossom servers' });
  });
});
