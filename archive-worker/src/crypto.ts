import { createCipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * AES-256-GCM encryption for private-tier archive blobs.
 *
 * Key lifecycle (see Flow O):
 *   1. Client generates 256-bit key K per archive request
 *   2. Client wraps K with their view key, stores long-term
 *   3. Client sends plaintext K to payment-proxy → passed to worker
 *   4. Worker encrypts rendered HTML with K, zeros K from memory
 *
 * The ciphertext layout is: [12-byte nonce][ciphertext][16-byte tag].
 * Standard GCM format, self-contained so the reader only needs K to
 * decrypt.
 */

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypt a buffer under a base64-encoded 32-byte key.
 * Returns a new Buffer laid out as: nonce || ciphertext || tag.
 * After this returns, the caller should overwrite the key string
 * (best-effort, since V8 makes this imperfect — see zeroize() below).
 */
export function encryptBlob(plaintext: Buffer, base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.byteLength !== 32) {
    throw new Error(`archive key must be 32 bytes, got ${key.byteLength}`);
  }

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Best-effort key zeroization. Node's Buffer is backed by an
  // ArrayBuffer we can overwrite; V8 may have copied the string
  // elsewhere but we do what we can.
  zeroize(key);

  return Buffer.concat([nonce, ciphertext, tag]);
}

/**
 * Best-effort: overwrite buffer with zeros. Node's Buffer backing
 * ArrayBuffer is directly writable; the original base64 string that
 * this was decoded from is immutable and may persist in V8's string
 * pool until GC. This is acknowledged in Flow O as the ~500ms–5s
 * trust window for the worker.
 */
export function zeroize(buf: Buffer): void {
  buf.fill(0);
}

/**
 * Constant-time comparison for authentication-related checks.
 * Wrapper around Node's timingSafeEqual with graceful length handling.
 */
export function constantTimeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const aBuf = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bBuf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// ── Chunked format (v2) — large media blobs ───────────────────────────
//
// Whole-file AES-GCM forced the client to buffer ciphertext + plaintext
// + Blob (~3× file size) in memory at decrypt time, which gets a 1 GB+
// video killed on iOS. v2 frames the blob into independently
// authenticated GCM chunks the client can decrypt one at a time with
// bounded memory:
//
//   [8-byte magic "DMCHNK01"]
//   [4-byte BE plaintext-chunk-size]
//   chunk[i]: [12-byte nonce][ciphertext + 16-byte tag]
//
// Each chunk's AAD binds the magic, its index, and a final-chunk flag,
// so chunks cannot be reordered, dropped, duplicated, or truncated
// without failing authentication. Mirror of the reader in
// frontend/src/lib/archives/chunked-blob.ts.

export const CHUNKED_BLOB_MAGIC = Buffer.from('DMCHNK01', 'ascii');
export const CHUNK_PLAINTEXT_BYTES = 8 * 1024 * 1024;

export function chunkAad(index: number, isFinal: boolean): Buffer {
  const aad = Buffer.alloc(CHUNKED_BLOB_MAGIC.length + 5);
  CHUNKED_BLOB_MAGIC.copy(aad, 0);
  aad.writeUInt32BE(index, CHUNKED_BLOB_MAGIC.length);
  aad.writeUInt8(isFinal ? 1 : 0, CHUNKED_BLOB_MAGIC.length + 4);
  return aad;
}

/** Encrypt a buffer into the chunked v2 layout. Peak memory ≈ input +
 *  output (the per-chunk pipeline never copies the whole plaintext
 *  again, unlike the old single-message path). */
export function encryptBlobChunked(
  plaintext: Buffer,
  base64Key: string,
  chunkBytes = CHUNK_PLAINTEXT_BYTES,
): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.byteLength !== 32) {
    throw new Error(`archive key must be 32 bytes, got ${key.byteLength}`);
  }
  const header = Buffer.alloc(CHUNKED_BLOB_MAGIC.length + 4);
  CHUNKED_BLOB_MAGIC.copy(header, 0);
  header.writeUInt32BE(chunkBytes, CHUNKED_BLOB_MAGIC.length);

  const chunkCount = Math.max(1, Math.ceil(plaintext.byteLength / chunkBytes));
  const frames: Buffer[] = [header];
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkBytes;
    const slice = plaintext.subarray(start, Math.min(start + chunkBytes, plaintext.byteLength));
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(chunkAad(i, i === chunkCount - 1));
    const body = Buffer.concat([cipher.update(slice), cipher.final()]);
    frames.push(nonce, body, cipher.getAuthTag());
  }
  zeroize(key);
  return Buffer.concat(frames);
}

export function isChunkedBlob(bytes: Buffer): boolean {
  return bytes.byteLength > CHUNKED_BLOB_MAGIC.length
    && bytes.subarray(0, CHUNKED_BLOB_MAGIC.length).equals(CHUNKED_BLOB_MAGIC);
}
