import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as dns } from 'node:dns';

import {
  assertSafePublicHttpUrl,
  looksLikeIp,
  resolveSafePublicHttpUrl,
  safeFetch,
  UnsafeUrlError,
} from '@src/safe-url.js';

describe('resolveSafePublicHttpUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

describe('looksLikeIp (parity with api/src/safe-url.ts)', () => {
  // The api copy uses node:net.isIP (strict). The old archive-worker copy
  // used `/^[0-9.]+$/ || /^[0-9a-fA-F:]+$/` which wrongly classified
  // hex-looking single-label hosts like `deadbeef` as IPs — see
  // tests/api/safe-url.test.ts for the parallel guard.
  it('false for a hex-looking single-label host that the old regex mis-classified', () => {
    expect(looksLikeIp('deadbeef')).toBe(false);
    expect(looksLikeIp('feedface')).toBe(false);
  });

  it('true for plain IPv4 literals', () => {
    expect(looksLikeIp('93.184.216.34')).toBe(true);
    expect(looksLikeIp('127.0.0.1')).toBe(true);
  });

  it('true for bracketed IPv6 literals (strips [host])', () => {
    expect(looksLikeIp('[2606:2800:220:1:248:1893:25c8:1946]')).toBe(true);
    expect(looksLikeIp('::1')).toBe(true);
  });
});

describe('assertSafePublicHttpUrl — IP literals skip DNS', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never calls dns.lookup for an IPv6-literal URL', async () => {
    const lookupSpy = vi
      .spyOn(dns, 'lookup')
      .mockResolvedValue(undefined as never);

    await expect(
      assertSafePublicHttpUrl('https://[2606:2800:220:1:248:1893:25c8:1946]/'),
    ).resolves.toBeInstanceOf(URL);

    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it('never calls dns.lookup for an IPv4-literal URL', async () => {
    const lookupSpy = vi
      .spyOn(dns, 'lookup')
      .mockResolvedValue(undefined as never);

    await expect(
      assertSafePublicHttpUrl('https://93.184.216.34/'),
    ).resolves.toBeInstanceOf(URL);

    expect(lookupSpy).not.toHaveBeenCalled();
  });
});

describe('safeFetch — DNS rebinding defence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('pins a validated DNS answer into fetch (dispatcher passed for hostnames, skipped for IPs)', async () => {
    // Hostname URL: dns.lookup returns a single public IP. safeFetch must
    // pass a `dispatcher` to fetch so the connect uses our pinned address,
    // not whatever the OS resolver now returns.
    vi
      .spyOn(dns, 'lookup')
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);

    const fetchCalls: Array<{ dispatcher?: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init?: RequestInit & { dispatcher?: unknown }) => {
        fetchCalls.push({ dispatcher: init?.dispatcher });
        return new Response(null, { status: 200 });
      }),
    );

    await safeFetch('https://example.com/');

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.dispatcher, 'hostname URL must dispatch via pinned Agent').toBeTruthy();
  });

  it('does not pin a dispatcher for IP-literal URLs (no DNS to rebind)', async () => {
    const fetchCalls: Array<{ dispatcher?: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init?: RequestInit & { dispatcher?: unknown }) => {
        fetchCalls.push({ dispatcher: init?.dispatcher });
        return new Response(null, { status: 200 });
      }),
    );

    await safeFetch('https://93.184.216.34/');

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.dispatcher).toBeUndefined();
  });

  it('rejects when the resolved address is private and never calls fetch', async () => {
    // First dns.lookup returns RFC1918 — must reject before fetch.
    vi
      .spyOn(dns, 'lookup')
      .mockResolvedValue([{ address: '10.0.0.4', family: 4 }] as never);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(safeFetch('https://rebind-target.example/')).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pins only the address validated inside safeFetch — ignores later DNS flips', async () => {
    // dns.lookup is called once inside safeFetch (resolve+validate+pin).
    // The Agent's connect.lookup bypasses the OS resolver entirely, so
    // a rebind between the validate and the actual connect can't land a
    // private target. Assert that only ONE dns.lookup happens.
    let lookupCalls = 0;
    vi
      .spyOn(dns, 'lookup')
      .mockImplementation(async () => {
        lookupCalls += 1;
        // First (and only) call returns the public IP we pin.
        return [{ address: '93.184.216.34', family: 4 }];
      });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
      ),
    );

    await safeFetch('https://single-resolve.example/');

    expect(lookupCalls, 'DNS must be resolved once — pinning must not re-resolve').toBe(1);
  });
});