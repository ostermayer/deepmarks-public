import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { schnorr } from '@noble/curves/secp256k1';
import { BlossomClient } from './blossom.js';

// 32-byte test private key + matching schnorr pubkey.
const PRIVKEY = hexToBytes('11'.repeat(32));
const PUBKEY = bytesToHex(schnorr.getPublicKey(PRIVKEY));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function decodeAuth(header: string | null | undefined): {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  id: string;
  sig: string;
} {
  expect(header).toBeTruthy();
  expect(header).toMatch(/^Nostr /);
  const b64 = (header as string).slice('Nostr '.length);
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

describe('BlossomClient — constructor', () => {
  it('rejects a non-32-byte private key', () => {
    expect(
      () => new BlossomClient('https://blossom.deepmarks.org', new Uint8Array(16), PUBKEY)
    ).toThrow(/32 bytes/);
  });

  it('accepts a 32-byte key', () => {
    expect(
      () => new BlossomClient('https://blossom.deepmarks.org', PRIVKEY, PUBKEY)
    ).not.toThrow();
  });
});

describe('BlossomClient.upload', () => {
  it('hashes the blob with SHA-256 (CLAUDE.md content-addressing rule)', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    const client = new BlossomClient('https://blossom.deepmarks.org', PRIVKEY, PUBKEY);
    const blob = Buffer.from('hello-world-archive');
    const expected = bytesToHex(sha256(blob));
    const result = await client.upload(blob);
    expect(result.blobHash).toBe(expected);
    expect(result.size).toBe(blob.byteLength);
  });

  it('PUTs to /upload with a NIP-01-conformant kind:24242 auth event', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    const client = new BlossomClient('https://blossom.deepmarks.org', PRIVKEY, PUBKEY);
    const blob = Buffer.from('payload');
    await client.upload(blob);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://blossom.deepmarks.org/upload');
    expect((init as RequestInit).method).toBe('PUT');
    const auth = decodeAuth(((init as RequestInit).headers as Record<string, string>).Authorization);
    expect(auth.kind).toBe(24242);
    expect(auth.pubkey).toBe(PUBKEY);
    expect(auth.tags.find((t) => t[0] === 't')?.[1]).toBe('upload');
    expect(auth.tags.find((t) => t[0] === 'x')?.[1]).toBe(bytesToHex(sha256(blob)));
    // expiration tag must be set, and within 5 minutes.
    const exp = Number(auth.tags.find((t) => t[0] === 'expiration')?.[1] ?? 0);
    const now = Math.floor(Date.now() / 1000);
    expect(exp).toBeGreaterThan(now);
    expect(exp).toBeLessThan(now + 300);
  });

  it('signs the auth event with a schnorr signature that verifies', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    const client = new BlossomClient('https://blossom.deepmarks.org', PRIVKEY, PUBKEY);
    await client.upload(Buffer.from('x'));
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >;
    const auth = decodeAuth(headers.Authorization);
    // Verify the signature against the recomputed event id.
    const serialized = JSON.stringify([
      0,
      auth.pubkey,
      auth.created_at,
      auth.kind,
      auth.tags,
      auth.content
    ]);
    const expectedId = bytesToHex(sha256(new TextEncoder().encode(serialized)));
    expect(auth.id).toBe(expectedId);
    const verified = schnorr.verify(hexToBytes(auth.sig), hexToBytes(auth.id), hexToBytes(auth.pubkey));
    expect(verified).toBe(true);
  });

  it('throws on a non-2xx upload response', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 400 }));
    const client = new BlossomClient('https://blossom.deepmarks.org', PRIVKEY, PUBKEY);
    await expect(client.upload(Buffer.from('x'))).rejects.toThrow(/400/);
  });
});

describe('BlossomClient.mirror', () => {
  it('issues one PUT /mirror per target with a JSON body pointing at the source', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    const client = new BlossomClient('https://blossom.deepmarks.org', PRIVKEY, PUBKEY);
    const results = await client.mirror('deadbeef', [
      'https://primal.cdn',
      'https://satellite.cdn'
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://primal.cdn/mirror');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ url: 'https://blossom.deepmarks.org/deadbeef' });
  });

  it('reports per-mirror failures without aborting the rest', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 502 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const client = new BlossomClient('https://blossom.deepmarks.org', PRIVKEY, PUBKEY);
    const results = await client.mirror('deadbeef', ['https://a', 'https://b']);
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[1]).toMatchObject({ ok: true });
  });

  it('reports thrown errors as failed mirrors with the message', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection refused'));
    const client = new BlossomClient('https://blossom.deepmarks.org', PRIVKEY, PUBKEY);
    const results = await client.mirror('deadbeef', ['https://a']);
    expect(results[0]).toMatchObject({ ok: false, error: 'connection refused' });
  });
});
