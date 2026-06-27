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
  `GET /blossom/check-auth` on api.
- `blossom-server` starts with `/app/config.yml`, which sets
  `upload.requirePubkeyInRule: true` and an S3 storage rule scoped to
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
| General direct-file bookmarks | archive worker direct file downloader | 150 MB |
| Media archive add-on | archive worker / disk-backed direct media, podcast enclosure discovery, or yt-dlp + ffmpeg | 2 GB |
| Archive thumbnails | archive worker | small image blobs |

Private archives are encrypted before upload. Blossom still stores the
encrypted bytes, but it never receives the user's decryption key.

## Mirror fanout (BUD-04)

After a successful upload to `blossom.deepmarks.org`, the archive worker
issues a BUD-04 `PUT /mirror` to each configured backup Blossom server so
a blob survives the loss of the primary. The mirror list is **env-driven**
(`BLOSSOM_MIRROR_URLS`, comma-separated public `https` Blossom roots,
resolved in [`archive-worker/src/mirror-targets.ts`](../archive-worker/src/mirror-targets.ts)
— there is no hardcoded list). The current production default is a single
community mirror, `https://blossom.primal.net`; the user may also attach
their own backup servers per archive (up to 8). A blob is considered
durable once the primary upload verifies; mirror results are recorded but
a mirror failure does not fail the archive.

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
The blob server uses [`deploy/box-a/blossom-config.yml`](../deploy/box-a/blossom-config.yml)
and must log `Storage: s3 ready` on startup. S3 environment variables
alone are not enough for `ghcr.io/hzrd149/blossom-server:master`; the
config file is what selects the S3 backend.

Write requests (`PUT`, `POST`, `DELETE`) pass through Caddy
`forward_auth` to:

```
GET /blossom/check-auth
```

That route verifies the BUD-01 `kind:24242` auth event and only grants
write access when the signing pubkey equals `ARCHIVE_WORKER_PUBKEY`.

Keep the config-file `storage.rules[].pubkeys` allowlist scoped to
`${ARCHIVE_WORKER_PUBKEY}`. Do not add lifetime users or public npubs to
the Blossom write allowlist.

## Troubleshooting

If archive uploads fail:

1. Confirm `ARCHIVE_WORKER_PUBKEY` is set on Box A.
2. Confirm Box B's archive worker signs BUD-01 auth with the matching
   nsec.
3. Confirm the auth event is `kind:24242`, has a current `expiration`,
   and uses `t=upload`, `t=mirror`, or `t=delete`.
4. Confirm Caddy is forwarding writes through `/blossom/check-auth`.
5. Confirm `docker exec box-a-blossom-server-1 grep -E "backend: s3|requirePubkeyInRule" /app/config.yml`.
6. Confirm `/app/data/blobs` is absent or tiny. A growing directory
   there means Blossom is writing to local disk instead of S3.
