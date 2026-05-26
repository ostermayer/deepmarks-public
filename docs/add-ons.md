# Add-ons

Paid extras layered on top of the lifetime baseline. A user must be a
lifetime member before buying an add-on. Each add-on is a one-time
purchase through the same hosted BTCPay checkout model as lifetime
membership. The app never shows raw Lightning invoices for add-ons.

The Add-ons section in `/app/settings` is where web and Android users
discover and buy them. iOS/App Store builds may describe paid features,
but they do not show Lightning checkout buttons or purchase links.

## Archive media

- **Price:** 150,000 sats one time. This is an add-on beyond lifetime
  membership, not a per-video purchase.
- **Source:** the user bookmarks a page. If the URL points at a primary
  video/audio page or a direct audio/video file, the app queues a private
  media archive automatically. YouTube URLs are canonicalized to the
  11-character video id; other public media pages are normalized by URL.
- **Quality cap:** video is capped at 720p, enforced by the yt-dlp format
  selector. Audio-only sources such as podcast files use the best
  available audio stream.
- **Container + codecs:** MKV when possible, with stream-copy remuxing
  rather than a quality-changing transcode. Audio-only sources may retain
  an audio container such as MP3, M4A, Ogg, Opus, or Matroska audio.
- **Always private:** the downloaded media file is always encrypted and
  stored as a private blob, regardless of whether the bookmark/page URL
  is public. Only the npub that bookmarked the URL receives the archive
  record and the self-encrypted decrypt key. Deepmarks should not
  publicly redistribute media bytes.

## Flow

1. Lifetime user buys the one-time media archive add-on from Settings -> Add-ons.
2. Frontend POSTs `/add-on/video-archive/checkout` using NIP-98 auth.
   The route name is legacy; the product now covers supported primary
   video and audio media, not only YouTube/video URLs.
3. Server creates a BTCPay checkout for 150,000 sats and stages a pending
   media add-on entitlement keyed by the BTCPay invoice id.
4. BTCPay settlement webhook re-reads the invoice, verifies the settled
   amount, and stamps the pubkey as media-archive-enabled.
5. On future bookmark saves, web/mobile/extension clients detect eligible
   media URLs, generate a fresh AES-256-GCM `archiveKey`, and POST
   `/add-on/video-archive/enqueue` with `{ url, archiveKey, eventId,
   bookmarkSavedAt }`.
6. Box B archive-worker runs `yt-dlp` or direct-file capture, encrypts the
   media with `archiveKey`, uploads the ciphertext blob, and POSTs
   `/archive/callback`.
7. Box A records the archive in `dm:archives:<pubkey>` for the
   bookmarking npub only and refcounts the resulting ciphertext blob
   hash.
8. The normal archive-key reconciliation publishes `(blobHash ->
   archiveKey)` into the user's self-encrypted `deepmarks-archive-keys`
   set so future devices can decrypt it.

## Privacy Model

Every media archive job runs a fresh download and encrypts the bytes with
the bookmark owner's own `archiveKey`. The source key is still recorded
for metadata:

- YouTube: `yt:<videoId>`
- Generic media page: `video:<sha256-normalized-url>` (legacy key prefix)

That key is not used to reuse ciphertext across users. Reusing another
user's encrypted blob would give the new buyer a decrypt key that does
not match the blob, so the delete/refcount pivot remains the actual
`blobHash`.

## Adding A New Add-on

1. Add a route under `payment-proxy/src/routes/` for hosted checkout,
   entitlement status, and enqueue endpoints. Mirror
   `routes/youtube-archive.ts`: NIP-98 auth, per-pubkey rate limits,
   BTCPay metadata, and a clear entitlement record.
2. Extend `ArchiveJob` or define a new queue with the worker inputs.
3. Add a worker branch on `processJob` so the new `kind` does not run
   through the webpage Playwright path.
4. Add a card to `frontend/src/lib/components/AddOnsSection.svelte`.
5. Keep iOS/App Store builds behind `IS_APPLE_BUILD` so paid checkout UI
   remains unavailable in the iOS shell.
