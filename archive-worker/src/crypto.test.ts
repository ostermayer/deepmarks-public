import { describe, it, expect } from 'vitest';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { encryptBlob, constantTimeEqual, zeroize } from './crypto.js';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function genKeyB64(): string {
  return randomBytes(32).toString('base64');
}

function decryptBlob(layout: Buffer, base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  const nonce = layout.subarray(0, NONCE_BYTES);
  const tag = layout.subarray(layout.length - TAG_BYTES);
  const ciphertext = layout.subarray(NONCE_BYTES, layout.length - TAG_BYTES);
  const dec = createDecipheriv('aes-256-gcm', key, nonce);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ciphertext), dec.final()]);
}

describe('encryptBlob', () => {
  it('round-trips arbitrary plaintext', () => {
    const key = genKeyB64();
    const plaintext = Buffer.from('hello, world — this is the archive HTML', 'utf8');
    const cipher = encryptBlob(plaintext, key);
    expect(decryptBlob(cipher, key).toString('utf8')).toBe(plaintext.toString('utf8'));
  });

  it('handles binary blobs (image, pdf, etc.)', () => {
    const key = genKeyB64();
    const plaintext = randomBytes(1024 * 16);
    const cipher = encryptBlob(plaintext, key);
    const decrypted = decryptBlob(cipher, key);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('produces unique ciphertext for the same plaintext (random nonce)', () => {
    const key = genKeyB64();
    const plaintext = Buffer.from('same input');
    const a = encryptBlob(plaintext, key);
    const b = encryptBlob(plaintext, key);
    expect(a.equals(b)).toBe(false);
  });

  it('emits the documented layout: 12-byte nonce || ciphertext || 16-byte tag', () => {
    const key = genKeyB64();
    const plaintext = Buffer.from('abcdefgh'); // 8 bytes
    const cipher = encryptBlob(plaintext, key);
    expect(cipher.length).toBe(NONCE_BYTES + plaintext.length + TAG_BYTES);
  });

  it('rejects keys whose length is not 32 bytes', () => {
    const tooShort = Buffer.alloc(16).toString('base64');
    expect(() => encryptBlob(Buffer.from('x'), tooShort)).toThrow(/32 bytes/);
    const tooLong = Buffer.alloc(64).toString('base64');
    expect(() => encryptBlob(Buffer.from('x'), tooLong)).toThrow(/32 bytes/);
  });

  it('decryption fails for the wrong key (GCM authentication catches it)', () => {
    const right = genKeyB64();
    const wrong = genKeyB64();
    const cipher = encryptBlob(Buffer.from('secret'), right);
    expect(() => decryptBlob(cipher, wrong)).toThrow();
  });

  it('decryption fails on a single-bit ciphertext flip', () => {
    const key = genKeyB64();
    const cipher = encryptBlob(Buffer.from('x'.repeat(64)), key);
    // Buffer indexing is typed as `number | undefined` under
    // noUncheckedIndexedAccess; writeUInt8 is type-safe without the alarm.
    const pos = NONCE_BYTES + 5;
    cipher.writeUInt8(cipher.readUInt8(pos) ^ 0x01, pos);
    expect(() => decryptBlob(cipher, key)).toThrow();
  });
});

describe('constantTimeEqual', () => {
  it('returns true for equal-length equal contents', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
  });
  it('returns false for unequal contents', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
  });
  it('returns false for different lengths without throwing', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
  it('handles mixed string + Buffer inputs', () => {
    expect(constantTimeEqual('abc', Buffer.from('abc'))).toBe(true);
  });
});

describe('zeroize', () => {
  it('overwrites the buffer in place', () => {
    const buf = Buffer.from([1, 2, 3, 4]);
    zeroize(buf);
    expect(Array.from(buf)).toEqual([0, 0, 0, 0]);
  });
});
