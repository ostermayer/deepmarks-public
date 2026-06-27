import { promises as dns } from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import { isPrivateIp, looksLikeIp, UnsafeUrlError } from './safe-url.js';

export interface SafeHttpProxy {
  url: string;
  close(): Promise<void>;
}

export async function startSafeHttpProxy(): Promise<SafeHttpProxy> {
  const server = http.createServer();

  server.on('request', (req, res) => {
    void handleHttpRequest(req, res).catch((err) => {
      res.writeHead(err instanceof UnsafeUrlError ? 403 : 502);
      res.end(err instanceof Error ? err.message : String(err));
    });
  });

  server.on('connect', (req, clientSocket, head) => {
    const socket = clientSocket as net.Socket;
    socket.on('error', () => {
      socket.destroy();
    });
    void handleConnect(req, socket, head).catch((err) => {
      safeSocketWrite(socket, `HTTP/1.1 ${err instanceof UnsafeUrlError ? 403 : 502} Proxy Error\r\n\r\n`);
      socket.destroy();
    });
  });

  server.on('clientError', (_err, socket) => {
    safeSocketWrite(socket as net.Socket, 'HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('safe proxy did not bind to a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

async function handleConnect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
): Promise<void> {
  const target = parseConnectTarget(req.url ?? '');
  const resolved = await resolvePublicProxyHost(target.hostname);
  const upstream = net.connect({
    host: resolved.address,
    family: resolved.family,
    port: target.port,
  });
  const closeTunnel = (): void => {
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!upstream.destroyed) upstream.destroy();
  };
  clientSocket.on('close', () => {
    if (!upstream.destroyed) upstream.destroy();
  });
  upstream.on('close', () => {
    if (!clientSocket.destroyed) clientSocket.destroy();
  });
  clientSocket.on('error', closeTunnel);
  upstream.on('error', closeTunnel);
  upstream.once('connect', () => {
    safeSocketWrite(clientSocket, 'HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.byteLength > 0) safeSocketWrite(upstream, head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
}

async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const targetUrl = parseHttpProxyUrl(req);
  const resolved = await resolvePublicProxyHost(targetUrl.hostname);
  const port = Number(targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new UnsafeUrlError('invalid proxy target port');
  }
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: targetUrl.host };
  delete headers['proxy-connection'];

  const upstream = http.request({
    host: resolved.address,
    family: resolved.family,
    port,
    method: req.method,
    path: `${targetUrl.pathname}${targetUrl.search}`,
    headers,
    timeout: 120_000,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on('timeout', () => upstream.destroy(new Error('proxy upstream timeout')));
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502);
    res.end(err.message);
  });
  req.on('error', () => upstream.destroy());
  res.on('error', () => upstream.destroy());
  req.pipe(upstream);
}

function safeSocketWrite(socket: net.Socket, chunk: string | Buffer): void {
  if (!socket.destroyed && socket.writable) socket.write(chunk);
}

function parseConnectTarget(value: string): { hostname: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(`https://${value}`);
  } catch {
    throw new UnsafeUrlError('invalid CONNECT target');
  }
  const port = Number(parsed.port || 443);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new UnsafeUrlError('invalid CONNECT target port');
  }
  return { hostname: parsed.hostname, port };
}

function parseHttpProxyUrl(req: http.IncomingMessage): URL {
  const raw = req.url ?? '';
  let parsed: URL;
  try {
    parsed = raw.startsWith('http://') || raw.startsWith('https://')
      ? new URL(raw)
      : new URL(raw, `http://${req.headers.host ?? ''}`);
  } catch {
    throw new UnsafeUrlError('invalid proxy URL');
  }
  if (parsed.protocol !== 'http:') {
    throw new UnsafeUrlError(`proxy URL scheme ${parsed.protocol} not allowed without CONNECT`);
  }
  return parsed;
}

export async function resolvePublicProxyHost(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  if (!hostname) throw new UnsafeUrlError('empty proxy host');
  const lower = hostname.toLowerCase();
  if (!lower.includes('.') && !looksLikeIp(lower)) throw new UnsafeUrlError('single-label proxy host disallowed');
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')) {
    throw new UnsafeUrlError(`proxy hostname ${lower} is local`);
  }
  if (looksLikeIp(lower)) {
    if (isPrivateIp(lower)) throw new UnsafeUrlError(`proxy ip ${lower} is private`);
    return { address: lower, family: lower.includes(':') ? 6 : 4 };
  }

  const answers = await dns.lookup(lower, { all: true, verbatim: true });
  if (answers.length === 0) throw new UnsafeUrlError('proxy host has no dns answers');
  for (const answer of answers) {
    if (isPrivateIp(answer.address)) {
      throw new UnsafeUrlError(`${lower} resolves to private ${answer.address}`);
    }
  }
  const first = answers[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  }).catch(() => undefined);
}
