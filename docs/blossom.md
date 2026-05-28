# Blossom

Deepmarks runs a public-read Blossom server at:

```
https://blossom.deepmarks.org
```

It stores archive blobs created by Deepmarks infrastructure. It is not a
general-purpose public upload bucket, and users do not get direct upload
access.

## Access Model

Reads are open. Anyone who knows a blob hash can fetch it. For private
webpage, PDF, audio, and media archives, that response is encrypted
ciphertext; the decrypt key is published only into the bookmarking
npub's self-encrypted archive-key set.

Writes are restricted to the Deepmarks archive worker pubkey. That is
enforced in two layers:

- Caddy sends `PUT`, `POST`, and `DELETE` requests through
  `GET /blossom/check-auth` on payment-proxy.
- `blossom-server` also receives `WRITE_ALLOWLIST_PUBKEYS` set to
  `ARCHIVE_WORKER_PUBKEY`.

Lifetime users get archive storage through Deepmarks workflows, not by
uploading directly to Blossom. When a lifetime user saves a bookmark with
archiving enabled, the archive worker captures the bytes and uploads
them. When a lifetime user buys the media archive add-on, the worker uses
yt-dlp and ffmpeg to archive supported bookmarked video or audio pages privately.

## What Gets Stored

Deepmarks-created archive blobs only:

| Source | Stored by | Limit |
|---|---|---|
| Webpage archives | archive worker / Playwright + SingleFile | 150 MB |
| PDF bookmarks | archive worker direct file downloader | 150 MB |
| Podcast/audio file bookmarks | archive worker direct file downloader | 150 MB |
| Media archive add-on | archive worker / yt-dlp + ffmpeg | 2 GB |
| Archive thumbnails | archive worker | small image blobs |

Private archives are encrypted before upload. Blossom still stores the
encrypted bytes, but it never receives the user's decryption key.

## Hashes And Files

Blossom is content-addressed: blobs are fetched by SHA-256 hash. The hash
is the address and integrity check, but the server still stores and
serves actual bytes.

That distinction matters operationally. Hashes do not remove storage,
abuse, malware, or takedown concerns, so Deepmarks does not allow
arbitrary user uploads to this server.

## Deployment

Box A serves the informational landing page from
[`deploy/box-a/blossom-site/index.html`](../deploy/box-a/blossom-site/index.html).

Write requests (`PUT`, `POST`, `DELETE`) pass through Caddy
`forward_auth` to:

```
GET /blossom/check-auth
```

That route verifies the BUD-01 `kind:24242` auth event and only grants
write access when the signing pubkey equals `ARCHIVE_WORKER_PUBKEY`.

Keep `WRITE_ALLOWLIST_PUBKEYS: ${ARCHIVE_WORKER_PUBKEY}` on
`blossom-server` as a second layer. Do not add lifetime users or public
npubs to the Blossom write allowlist.

## Troubleshooting

If archive uploads fail:

1. Confirm `ARCHIVE_WORKER_PUBKEY` is set on Box A.
2. Confirm Box B's archive worker signs BUD-01 auth with the matching
   nsec.
3. Confirm the auth event is `kind:24242`, has a current `expiration`,
   and uses `t=upload`, `t=mirror`, or `t=delete`.
4. Confirm Caddy is forwarding writes through `/blossom/check-auth`.
5. Confirm `WRITE_ALLOWLIST_PUBKEYS` on `blossom-server` is the same
   archive worker pubkey.
