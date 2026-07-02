// safeFetch is the SSRF-guarded fetch: it validates the URL, DNS-resolves it,
// rejects any private resolved address, then fetches. (Connect-level IP
// pinning against DNS rebinding was attempted but reverted — it needs undici's
// own fetch to match its Agent version, which differs across the deployed
// boxes; it's a tracked follow-up. Redirect-based SSRF is closed by callers
// walking redirects manually + re-validating each hop.) These cases guard the
// resolve/validate behavior.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { UnsafeUrlError, safeFetch } from '@src/safe-url.js';

describe('safeFetch IP pinning', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('fetches IP-literal hosts directly (no DNS to rebind, no pinning dispatcher)', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await safeFetch('https://93.184.216.34/', {});
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to fetch when the host resolves to a private address', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      safeFetch('https://rebind.example/', {}, { dnsLookup: async () => [{ address: '10.0.0.2' }] }),
    ).rejects.toThrow(UnsafeUrlError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a private IP literal before any fetch', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(safeFetch('http://[::ffff:10.0.0.4]/', {})).rejects.toThrow(UnsafeUrlError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
