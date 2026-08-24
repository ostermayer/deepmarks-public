# Encrypted archive blob formats

Private-tier archive blobs (and ALL media blobs — media is always
encrypted for copyright reasons) are AES-256-GCM ciphertexts stored on
Blossom under the sha256 of the ciphertext. The 32-byte key is generated
client-side, sent to the api over TLS for the worker's one-time use,
zeroized after encryption, and recoverable by the user from their
NIP-44-encrypted archive-key set (kind:30003,
`d=deepmarks-archive-keys*`) — see `archives.md` for the key lifecycle.

Two wire formats exist. The writer is
`archive-worker/src/crypto.ts`; the readers are
`frontend/src/lib/nostr/archive-keys.ts` (v1) and
`frontend/src/lib/archives/chunked-blob.ts` (v2). Cross-implementation
vector tests live in
`tests/frontend/regression/archive-crypto-cross-impl.test.ts`.

## v1 — whole-file (webpage HTML, PDF, sidecar files)

```
[12-byte nonce][ciphertext][16-byte GCM tag]
```

One GCM message. Simple, but decryption requires the whole ciphertext
and plaintext in memory simultaneously — fine for page-sized blobs,
fatal for gigabyte media on iOS. Still written for non-media files
(small, and the browser extension's archive viewer only speaks v1).

## v2 — chunked (`DMCHNK01`, all media files)

```
[8-byte magic "DMCHNK01"]
[4-byte big-endian plaintext-chunk-size]        ← 8 MiB in production
chunk[i]: [12-byte nonce][ciphertext + 16-byte GCM tag]
```

- Every chunk is an independent AES-256-GCM message under the same key
  with a fresh random nonce.
- Each chunk's **AAD** is `"DMCHNK01" || uint32BE(index) || uint8(isFinal)`
  — chunks cannot be reordered, dropped, duplicated, or truncated
  without failing authentication. Dropping the trailing chunk fails
  because the new "last" chunk was sealed with `isFinal = 0`.
- All chunks are `chunk-size` bytes of plaintext except the final one.
  A frame's ciphertext length is therefore `chunk-size + 16` except the
  last, which is whatever remains — readers detect the final frame by
  EOF, then verify via the AAD flag.

### Reading with bounded memory

`fetchArchiveBlob()` (frontend) sniffs the first 8 bytes off the network
stream: magic match → consume the stream frame-by-frame, decrypt each
chunk, and hand the plaintext parts straight to `new Blob(parts)` —
browsers back large Blobs with disk, so peak memory is ~one chunk
regardless of file size. No magic → buffer and fall back to v1.
`fetchArchiveBytes()` also understands v2 but returns a contiguous
buffer (zip/export paths).

### Compatibility rules

- Old v1 media blobs remain readable forever (format sniff, not a
  version flag on the record).
- Do not write v2 for non-media roles until the extension's viewer
  learns the format.
- Changing the chunk size only affects new blobs — the size is read
  from the header.

## Streaming playback (MSE)

Media blobs that yt-dlp delivered in an MP4-family container are
remuxed (no re-encode) to **fragmented MP4** before encryption, and the
archive record carries an RFC 6381 type string (`mseCodecs`, e.g.
`video/mp4; codecs="avc1.64001F,mp4a.40.2"`) probed via ffprobe
(`archive-worker/src/mse-codecs.ts`).

At play time, `openArchiveMediaStream()` checks
`MediaSource.isTypeSupported(mseCodecs)`, then feeds each decrypted v2
chunk straight into a SourceBuffer as it arrives off the network —
playback starts after the first chunks instead of after the full
download. Fragmented MP4 is required because MSE accepts that byte
stream at arbitrary append boundaries, which is exactly what the
fixed-size encrypted chunks produce. Any miss in the chain (no codecs
string, unmappable codec, v1 blob, no MSE support) falls back to the
bounded-memory Blob path, which always works.
