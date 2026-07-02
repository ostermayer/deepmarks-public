// Regression: the SSRF guard's isPrivateIp misclassified IPv6 literals as
// public. Bracketed loopback/ULA/link-local and — critically — IPv4-mapped
// IPv6 in the URL-parser's hex form (`[::ffff:10.0.0.4]` → `[::ffff:a00:4]`)
// slipped past validateSafePublicHttpUrl and reached internal targets
// (Box C 10.0.0.4, 169.254.169.254 metadata) over a dual-stack connect.

import { describe, expect, it } from 'vitest';

import {
  UnsafeUrlError,
  assertSafeResolvedPublicHttpUrl,
  embeddedIpv4,
  isPrivateIp,
  safeFetch,
  validateSafePublicHttpUrl,
} from '@src/safe-url.js';

describe('IPv6-literal SSRF guard (api)', () => {
  const internalLiterals = [
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:10.0.0.4]/',            // Box C signer
    'http://[::ffff:127.0.0.1]:4000/',      // loopback:api
    'http://[::ffff:169.254.169.254]/',     // cloud metadata
    'http://[0:0:0:0:0:ffff:a00:4]:6379/',  // fully-expanded mapped form
    'http://[::ffff:192.168.1.1]/',
    'http://[::ffff:172.16.0.9]/',
  ];

  for (const url of internalLiterals) {
    it(`rejects internal IPv6 literal ${url}`, () => {
      expect(() => validateSafePublicHttpUrl(url)).toThrow(UnsafeUrlError);
    });
    it(`rejects ${url} via the resolved guard without a DNS lookup`, async () => {
      const dnsLookup = async () => { throw new Error('IP literals must not hit DNS'); };
      await expect(assertSafeResolvedPublicHttpUrl(url, { dnsLookup })).rejects.toThrow(UnsafeUrlError);
    });
  }

  it('still accepts genuine public IPv6 literals', () => {
    expect(() => validateSafePublicHttpUrl('http://[2606:4700:4700::1111]/')).not.toThrow();
    expect(() => validateSafePublicHttpUrl('http://[2001:4860:4860::8888]/')).not.toThrow();
  });

  it('embeddedIpv4 extracts the mapped address from both hex and dotted forms', () => {
    expect(embeddedIpv4('::ffff:a00:4')).toBe('10.0.0.4');
    expect(embeddedIpv4('::ffff:169.254.169.254')).toBe('169.254.169.254');
    expect(embeddedIpv4('2606:4700::1')).toBeNull();
  });

  it('isPrivateIp classifies bracketed + mapped internal literals as private', () => {
    expect(isPrivateIp('[::1]')).toBe(true);
    expect(isPrivateIp('[::ffff:a00:4]')).toBe(true);
    expect(isPrivateIp('[2606:4700:4700::1111]')).toBe(false);
  });

  it('safeFetch refuses a hostname that resolves to a mapped internal address', async () => {
    // The A record answers a mapped-IPv6 loopback; safeFetch must reject
    // before issuing the request (the response would otherwise be pinned to
    // and fetched from the internal target).
    const dnsLookup = async () => [{ address: '10.0.0.2' }];
    await expect(safeFetch('http://rebind.example/', {}, { dnsLookup })).rejects.toThrow(UnsafeUrlError);
  });
});
