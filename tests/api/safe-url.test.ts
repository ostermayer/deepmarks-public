import { describe, expect, it } from 'vitest';

import { UnsafeUrlError, assertSafeResolvedPublicHttpUrl, looksLikeIp, validateSafePublicHttpUrl } from '@src/safe-url.js';

describe('api safe URL guard', () => {
  it('does not treat hex-looking single-label hosts as IP literals', async () => {
    expect(looksLikeIp('deadbeef')).toBe(false);
    expect(() => validateSafePublicHttpUrl('http://deadbeef/')).toThrow(UnsafeUrlError);

    const dnsLookup = async () => [{ address: '93.184.216.34' }];
    await expect(assertSafeResolvedPublicHttpUrl('http://deadbeef/', { dnsLookup })).rejects.toThrow(UnsafeUrlError);
  });

  it('still accepts public IP literals without a DNS lookup', async () => {
    const dnsLookup = async () => {
      throw new Error('should not lookup IP literals');
    };

    await expect(assertSafeResolvedPublicHttpUrl('https://93.184.216.34/', { dnsLookup })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeResolvedPublicHttpUrl('https://[2606:2800:220:1:248:1893:25c8:1946]/', { dnsLookup }))
      .resolves.toBeInstanceOf(URL);
  });
});
