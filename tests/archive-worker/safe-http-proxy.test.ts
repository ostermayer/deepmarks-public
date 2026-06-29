import { describe, expect, it } from 'vitest';
import net from 'node:net';

import { resolvePublicProxyHost, startSafeHttpProxy } from '@src/safe-http-proxy.js';

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

  it('handles rejected CONNECT clients without crashing the proxy', async () => {
    const proxy = await startSafeHttpProxy();
    try {
      const proxyUrl = new URL(proxy.url);
      const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname);
      socket.on('error', () => {});
      await once(socket, 'connect');

      socket.write('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n');
      const response = await onceData(socket);

      expect(response).toContain('403 Proxy Error');
    } finally {
      await proxy.close();
    }
  });
});

function once(socket: net.Socket, event: 'connect'): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once(event, () => resolve());
    socket.once('error', reject);
  });
}

function onceData(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('data', (chunk) => resolve(chunk.toString('utf8')));
    socket.once('error', reject);
  }).finally(() => socket.destroy());
}
