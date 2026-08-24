// Regression: archive-worker's isPrivateIp did not strip IPv6 brackets and
// only recognized IPv4-mapped addresses in dotted form, so every bracketed
// IPv6 literal (incl. `[::ffff:10.0.0.4]`) read as public. Because the
// direct-file downloader stores the fetched body as the user's retrievable
// archive, that was a read/exfil primitive into the VPC.

import { describe, expect, it } from 'vitest';

import {
  UnsafeUrlError,
  assertSafePublicHttpUrl,
  embeddedIpv4,
  isPrivateIp,
} from '@src/safe-url.js';

describe('IPv6-literal SSRF guard (archive-worker)', () => {
  const internalLiterals = [
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:10.0.0.4]/',
    'http://[::ffff:127.0.0.1]:4000/',
    'http://[::ffff:169.254.169.254]/',
    'http://[0:0:0:0:0:ffff:a00:4]:6379/',
  ];

  for (const url of internalLiterals) {
    it(`assertSafePublicHttpUrl rejects ${url}`, async () => {
      await expect(assertSafePublicHttpUrl(url)).rejects.toThrow(UnsafeUrlError);
    });
  }

  it('still accepts genuine public IPv6 literals', async () => {
    await expect(assertSafePublicHttpUrl('http://[2606:4700:4700::1111]/')).resolves.toBeInstanceOf(URL);
  });

  it('isPrivateIp handles bracketed + mapped forms', () => {
    expect(isPrivateIp('[::1]')).toBe(true);
    expect(isPrivateIp('[::ffff:a00:4]')).toBe(true);
    expect(isPrivateIp('[::ffff:169.254.169.254]')).toBe(true);
    expect(isPrivateIp('[2606:4700:4700::1111]')).toBe(false);
  });

  it('embeddedIpv4 extracts hex + dotted mapped addresses', () => {
    expect(embeddedIpv4('::ffff:a00:4')).toBe('10.0.0.4');
    expect(embeddedIpv4('::ffff:10.0.0.4')).toBe('10.0.0.4');
    expect(embeddedIpv4('2606:4700::1')).toBeNull();
  });
});
