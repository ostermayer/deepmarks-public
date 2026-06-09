// Cross-implementation vector test for the private-archive pipeline
// (closes the coverage gap flagged in the 2026-06 review, ARCH section):
// the archive-worker encrypts on Box B with node:crypto and the frontend
// decrypts in the browser with WebCrypto. Nothing previously proved the
// two implementations agree byte-for-byte on the wire format
// ([12-byte nonce][ciphertext][16-byte GCM tag], base64 key) — a drift
// here means every paid private/media archive becomes undecryptable.

import { describe, expect, it } from 'vitest';
import { encryptBlob } from '../../../archive-worker/src/crypto.js';
import { decryptArchiveBlob, generateArchiveKey } from '$lib/nostr/archive-keys';

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
