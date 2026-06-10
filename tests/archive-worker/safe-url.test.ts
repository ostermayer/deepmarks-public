import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveSafePublicHttpUrl, UnsafeUrlError } from '@src/safe-url.js';

describe('resolveSafePublicHttpUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a public URL that redirects to a private address', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/admin' },
    })));

    await expect(resolveSafePublicHttpUrl('http://93.184.216.34/video')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('returns the final public redirect target', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: 'http://93.184.216.35/final' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveSafePublicHttpUrl('http://93.184.216.34/video');

    expect(resolved.toString()).toBe('http://93.184.216.35/final');
  });
});
