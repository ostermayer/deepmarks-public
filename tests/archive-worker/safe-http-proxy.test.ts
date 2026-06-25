import { describe, expect, it } from 'vitest';
import { resolvePublicProxyHost } from '@src/safe-http-proxy.js';

describe('safe yt-dlp HTTP proxy validation', () => {
  it('rejects loopback and link-local targets before opening a tunnel', async () => {
    await expect(resolvePublicProxyHost('127.0.0.1')).rejects.toThrow(/private/);
    await expect(resolvePublicProxyHost('169.254.169.254')).rejects.toThrow(/private/);
    await expect(resolvePublicProxyHost('::1')).rejects.toThrow(/private/);
  });

  it('rejects local hostnames', async () => {
    await expect(resolvePublicProxyHost('localhost')).rejects.toThrow(/local|single-label/);
    await expect(resolvePublicProxyHost('printer.local')).rejects.toThrow(/local/);
  });
});
