import { describe, expect, it } from 'vitest';
import { objectKeyCandidates } from '@src/blossom-blob-store.js';

describe('objectKeyCandidates', () => {
  const hash = 'a'.repeat(64);

  it('includes the bare hash for existing objects stored without an extension', () => {
    expect(objectKeyCandidates({ blobHash: hash })).toEqual([hash]);
  });

  it('adds MIME and path extension candidates without duplicates', () => {
    expect(objectKeyCandidates({
      blobHash: hash,
      contentType: 'text/html; charset=utf-8',
      fileName: 'saved.html',
      url: 'https://example.com/report.pdf',
    })).toEqual([hash, `${hash}.html`, `${hash}.pdf`]);
  });

  it('uses JPEG extension names compatible with Blossom storage', () => {
    expect(objectKeyCandidates({
      blobHash: hash,
      contentType: 'image/jpeg',
    })).toEqual([hash, `${hash}.jpeg`, `${hash}.jpg`]);
  });
});
