// Cross-implementation vector test for the private-archive pipeline
// (closes the coverage gap flagged in the 2026-06 review, ARCH section):
// the archive-worker encrypts on Box B with node:crypto and the frontend
// decrypts in the browser with WebCrypto. Nothing previously proved the
// two implementations agree byte-for-byte on the wire format
// ([12-byte nonce][ciphertext][16-byte GCM tag], base64 key) — a drift
// here means every paid private/media archive becomes undecryptable.

import { describe, expect, it } from 'vitest';
import { encryptBlob, encryptBlobChunked } from '../../../archive-worker/src/crypto.js';
import { decryptArchiveBlob, generateArchiveKey } from '$lib/nostr/archive-keys';
import {
  decryptChunkedArchiveBlob,
  isChunkedArchiveBlob,
} from '$lib/archives/chunked-blob';

function concat(parts: Uint8Array[]): Buffer {
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

describe('archive-worker encryptBlob → frontend decryptArchiveBlob', () => {
  it('round-trips bytes through both implementations', async () => {
    const key = generateArchiveKey();
    const plaintext = Buffer.from('archived page <html>… with utf-8 → ✓</html>', 'utf8');

    const ciphertext = encryptBlob(plaintext, key);
    const decrypted = await decryptArchiveBlob(new Uint8Array(ciphertext), key);

    expect(Buffer.from(decrypted).equals(plaintext)).toBe(true);
  });

  it('generateArchiveKey emits the exact wire format the worker validates', () => {
    const key = generateArchiveKey();
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}=?$/);
    expect(Buffer.from(key, 'base64').byteLength).toBe(32);
  });

  it('rejects a tampered ciphertext (GCM auth)', async () => {
    const key = generateArchiveKey();
    const ciphertext = new Uint8Array(encryptBlob(Buffer.from('payload'), key));
    ciphertext[20] ^= 0xff;

    await expect(decryptArchiveBlob(ciphertext, key)).rejects.toThrow();
  });

  it('rejects the wrong key', async () => {
    const ciphertext = new Uint8Array(encryptBlob(Buffer.from('payload'), generateArchiveKey()));

    await expect(decryptArchiveBlob(ciphertext, generateArchiveKey())).rejects.toThrow();
  });

  it('handles a large blob without format drift (1 MiB)', async () => {
    const key = generateArchiveKey();
    const plaintext = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = i % 251;

    const decrypted = await decryptArchiveBlob(new Uint8Array(encryptBlob(plaintext, key)), key);

    expect(Buffer.from(decrypted).equals(plaintext)).toBe(true);
  });
});

describe('chunked v2: worker encryptBlobChunked → frontend chunked reader', () => {
  it('round-trips a multi-chunk blob with bounded-memory parts', async () => {
    const key = generateArchiveKey();
    const plaintext = Buffer.alloc(5 * 1024 * 1024 + 137); // ~5 MiB, not chunk-aligned
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = (i * 7) % 251;

    const ciphertext = encryptBlobChunked(plaintext, key, 1024 * 1024); // 1 MiB chunks → 6 frames
    expect(isChunkedArchiveBlob(new Uint8Array(ciphertext))).toBe(true);

    const parts = await decryptChunkedArchiveBlob(new Uint8Array(ciphertext), key);
    expect(parts.length).toBe(6);
    expect(concat(parts).equals(plaintext)).toBe(true);
  });

  it('legacy v1 blobs are not mistaken for chunked', () => {
    const v1 = encryptBlob(Buffer.from('legacy payload'), generateArchiveKey());
    expect(isChunkedArchiveBlob(new Uint8Array(v1))).toBe(false);
  });

  it('rejects reordered chunks (index-bound AAD)', async () => {
    const key = generateArchiveKey();
    const chunkBytes = 1024;
    const plaintext = Buffer.alloc(chunkBytes * 3); // exactly 3 chunks
    const ciphertext = encryptBlobChunked(plaintext, key, chunkBytes);

    const header = 12; // 8-byte magic + 4-byte size
    const frame = 12 + chunkBytes + 16;
    const swapped = Buffer.from(ciphertext);
    ciphertext.copy(swapped, header, header + frame, header + 2 * frame);          // chunk1 -> slot0
    ciphertext.copy(swapped, header + frame, header, header + frame);              // chunk0 -> slot1

    await expect(decryptChunkedArchiveBlob(new Uint8Array(swapped), key)).rejects.toThrow();
  });

  it('rejects truncation that drops the final chunk (final-flag AAD)', async () => {
    const key = generateArchiveKey();
    const chunkBytes = 1024;
    const plaintext = Buffer.alloc(chunkBytes * 2);
    const ciphertext = encryptBlobChunked(plaintext, key, chunkBytes);

    const frame = 12 + chunkBytes + 16;
    const truncated = ciphertext.subarray(0, ciphertext.byteLength - frame);

    await expect(decryptChunkedArchiveBlob(new Uint8Array(truncated), key)).rejects.toThrow();
  });

  it('rejects a tampered chunk body', async () => {
    const key = generateArchiveKey();
    const ciphertext = Buffer.from(encryptBlobChunked(Buffer.from('media bytes'), key, 1024));
    ciphertext[ciphertext.byteLength - 5] ^= 0xff;

    await expect(decryptChunkedArchiveBlob(new Uint8Array(ciphertext), key)).rejects.toThrow();
  });
});
