// Regression guard for audit finding ARCH-A2 (2026-06 review), now FIXED:
// the archive-worker fans archives out to Blossom mirrors (BUD-04) and the
// mirror list is stored on the archive record, but fetchArchiveBytes used to
// fetch only the primary Blossom URL — one primary 404 made the archive
// unviewable on every device even though the bytes existed on a mirror
// listed in the very record being rendered. fetchArchiveBytes now falls
// back to recorded mirrors and verifies public mirror bytes against the
// content hash before trusting a third-party server.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { fetchArchiveBytes, archiveBlobUrl } from '$lib/archives/download';
import type { ArchiveRecord } from '$lib/api/client';

const BYTES = new TextEncoder().encode('<html>archived</html>');
const BLOB_HASH = createHash('sha256').update(BYTES).digest('hex');
const MIRROR = 'https://mirror.example.com';

function record(): ArchiveRecord {
  return {
    url: 'https://example.com/article',
    blobHash: BLOB_HASH,
    tier: 'public',
    archivedAt: 1_700_000_000,
    mirrors: [{ url: MIRROR, ok: true }],
  } as ArchiveRecord;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchArchiveBytes when the primary Blossom server lost the blob', () => {
  it('falls back to a mirror recorded on the archive record', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === archiveBlobUrl(BLOB_HASH)) {
        return new Response('not found', { status: 404 });
      }
      if (url === `${MIRROR}/${BLOB_HASH}`) {
        return new Response(BYTES, { status: 200 });
      }
      return new Response('unexpected url', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const bytes = await fetchArchiveBytes(record());

    expect(new TextDecoder().decode(bytes)).toBe('<html>archived</html>');
    expect(fetchMock).toHaveBeenCalledWith(`${MIRROR}/${BLOB_HASH}`);
  });

  it('rejects mirror bytes that do not match the public blob hash', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === archiveBlobUrl(BLOB_HASH)) {
        return new Response('not found', { status: 404 });
      }
      return new Response('tampered content', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchArchiveBytes(record())).rejects.toThrow(/hash/);
  });

  it('still fails cleanly when primary and all mirrors are down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })));

    await expect(fetchArchiveBytes(record())).rejects.toThrow(/blossom fetch 404/);
  });
});
