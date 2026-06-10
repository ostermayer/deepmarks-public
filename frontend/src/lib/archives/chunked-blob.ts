// Reader for the chunked archive-blob layout (v2, "DMCHNK01") that the
// archive-worker writes for media files — mirror of
// archive-worker/src/crypto.ts encryptBlobChunked:
//
//   [8-byte magic "DMCHNK01"]
//   [4-byte BE plaintext-chunk-size]
//   chunk[i]: [12-byte nonce][ciphertext + 16-byte tag]
//
// Each chunk's AAD binds (magic, index, final-flag), so reordering,
// dropping, duplicating, or truncating chunks fails authentication.
//
// The point of the format: the old whole-file AES-GCM decrypt needed
// ciphertext + plaintext + Blob in memory at once (~3× file size) —
// instantly fatal for a 1 GB+ video on iOS. Here the ciphertext is
// consumed INCREMENTALLY from the network stream and each ~8 MiB chunk
// is decrypted independently; the decrypted parts go straight into a
// Blob, which browsers back with disk for large payloads.

const MAGIC = new TextEncoder().encode('DMCHNK01');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024; // sanity bound on the header field

export function isChunkedArchiveBlob(bytes: Uint8Array): boolean {
  if (bytes.byteLength <= MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return false;
  }
  return true;
}

function chunkAad(index: number, isFinal: boolean): Uint8Array {
  const aad = new Uint8Array(MAGIC.length + 5);
  aad.set(MAGIC, 0);
  new DataView(aad.buffer).setUint32(MAGIC.length, index, false);
  aad[MAGIC.length + 4] = isFinal ? 1 : 0;
  return aad;
}

async function importArchiveKey(archiveKeyBase64: string): Promise<CryptoKey> {
  const bin = atob(archiveKeyBase64);
  const keyBytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) keyBytes[i] = bin.charCodeAt(i);
  if (keyBytes.byteLength !== 32) {
    throw new Error(`archive key must be 32 bytes, got ${keyBytes.byteLength}`);
  }
  return crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

/** Incremental byte source over a fetch body (or a plain buffer). */
interface ByteSource {
  /** Read exactly n bytes, or fewer iff the source ends; null at EOF. */
  read(n: number): Promise<Uint8Array | null>;
}

function bufferSource(bytes: Uint8Array): ByteSource {
  let offset = 0;
  return {
    async read(n: number) {
      if (offset >= bytes.byteLength) return null;
      const slice = bytes.subarray(offset, Math.min(offset + n, bytes.byteLength));
      offset += slice.byteLength;
      return slice;
    },
  };
}

function streamSource(stream: ReadableStream<Uint8Array>): ByteSource {
  const reader = stream.getReader();
  let pending: Uint8Array | null = null;
  let done = false;
  return {
    async read(n: number) {
      const parts: Uint8Array[] = [];
      let have = 0;
      while (have < n) {
        if (pending && pending.byteLength > 0) {
          const take = pending.subarray(0, Math.min(n - have, pending.byteLength));
          pending = take.byteLength < pending.byteLength ? pending.subarray(take.byteLength) : null;
          parts.push(take);
          have += take.byteLength;
          continue;
        }
        if (done) break;
        const next = await reader.read();
        if (next.done) { done = true; break; }
        pending = next.value;
      }
      if (have === 0) return null;
      if (parts.length === 1) return parts[0]!;
      const out = new Uint8Array(have);
      let at = 0;
      for (const part of parts) { out.set(part, at); at += part.byteLength; }
      return out;
    },
  };
}

/** Progressive decrypt: yields each plaintext chunk as soon as its
 *  ciphertext frame arrives — the streaming-playback path appends these
 *  straight into a MediaSource buffer. Caller has already consumed +
 *  verified the 8-byte magic. */
export async function* decryptChunkedArchiveChunks(
  source: ByteSource,
  archiveKeyBase64: string,
): AsyncGenerator<Uint8Array, void, void> {
  const key = await importArchiveKey(archiveKeyBase64);
  const sizeBytes = await source.read(4);
  if (!sizeBytes || sizeBytes.byteLength !== 4) throw new Error('chunked archive header truncated');
  const chunkBytes = new DataView(sizeBytes.buffer, sizeBytes.byteOffset).getUint32(0, false);
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > MAX_CHUNK_BYTES) {
    throw new Error(`chunked archive declares implausible chunk size ${chunkBytes}`);
  }

  const frameBytes = NONCE_BYTES + chunkBytes + TAG_BYTES;
  let index = 0;
  let frame = await source.read(frameBytes);
  if (!frame) throw new Error('chunked archive has no chunks');
  while (frame) {
    const next = await source.read(frameBytes);
    const isFinal = next === null;
    if (frame.byteLength < NONCE_BYTES + TAG_BYTES + 1) {
      throw new Error('chunked archive frame truncated');
    }
    const nonce = frame.subarray(0, NONCE_BYTES);
    const body = frame.subarray(NONCE_BYTES);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: chunkAad(index, isFinal) as BufferSource },
      key,
      body as BufferSource,
    );
    yield new Uint8Array(plaintext);
    index += 1;
    frame = next;
  }
}

async function decryptChunkedFromSource(
  source: ByteSource,
  archiveKeyBase64: string,
): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  for await (const part of decryptChunkedArchiveChunks(source, archiveKeyBase64)) {
    parts.push(part);
  }
  return parts;
}

/** Decrypt a fully-buffered chunked blob into plaintext parts. */
export async function decryptChunkedArchiveBlob(
  bytes: Uint8Array,
  archiveKeyBase64: string,
): Promise<Uint8Array[]> {
  if (!isChunkedArchiveBlob(bytes)) throw new Error('not a chunked archive blob');
  return decryptChunkedFromSource(bufferSource(bytes.subarray(MAGIC.length)), archiveKeyBase64);
}

/** Decrypt a chunked blob straight off a network stream — the ciphertext
 *  is never held in memory whole. Returns plaintext parts for Blob
 *  construction. The first MAGIC.length bytes must already have been
 *  read (and matched) by the caller's format sniff. */
export async function decryptChunkedArchiveStream(
  stream: ReadableStream<Uint8Array>,
  archiveKeyBase64: string,
): Promise<Uint8Array[]> {
  return decryptChunkedFromSource(streamSource(stream), archiveKeyBase64);
}

/** Streaming helper for callers that need to sniff the format first:
 *  returns a ByteSource-like reader over the stream. */
export function createArchiveByteSource(stream: ReadableStream<Uint8Array>): {
  read(n: number): Promise<Uint8Array | null>;
} {
  return streamSource(stream);
}

/** Decrypt the body of a chunked blob from a source whose 8-byte magic
 *  has already been consumed (after a format sniff). */
export async function decryptChunkedArchiveBody(
  source: { read(n: number): Promise<Uint8Array | null> },
  archiveKeyBase64: string,
): Promise<Uint8Array[]> {
  return decryptChunkedFromSource(source, archiveKeyBase64);
}

export const CHUNKED_BLOB_MAGIC_LENGTH = MAGIC.length;
