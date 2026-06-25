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
  video/audio page, a streaming manifest, a direct audio/video/image
  file, a known podcast episode host, or a supported
  social/decentralized media host (including Reddit/X/Imgur and common
  PeerTube URL shapes), the app queues a private media archive
  automatically. YouTube URLs are
  canonicalized to the 11-character video id, and only watch/short/embed
  style YouTube video URLs are eligible. Search pages, channel pages,
  and YouTube captcha URLs are ignored instead of queued. Other public
  media pages are normalized by URL.
- **Best-effort capture:** Deepmarks attempts to archive associated
  media on eligible pages, but provider bot restrictions, login walls,
  removed media, unsupported players, or extractor limits can prevent a
  complete media archive.
- **Quality cap:** video is capped at 720p, enforced by the yt-dlp format
  selector. Audio-only sources such as podcast files use the best
  available audio stream.
- **Size cap:** media captures are capped at 2 GB by default. Hosted
  yt-dlp captures, direct media files, and podcast enclosures all use
  the media cap and disk-backed worker scratch storage.
- **Container + codecs:** MP4/H.264/AAC is preferred for mobile
  playback; MKV is the fallback when a provider lacks a compatible MP4
  stream. Audio-only sources may retain an audio container such as MP3,
  M4A/M4B, Ogg, Opus, or Matroska audio. Direct images, including HEIC,
  TIFF, and SVG, keep their original image content type in the archive
  record.
- **Sidecars:** for yt-dlp media pages, the worker best-effort stores
  metadata JSON, thumbnails, and English subtitle/transcript files as
  encrypted sibling files on the same archive record when the provider
  exposes them.
- **Podcast scope:** podcast episode pages resolve through RSS/Atom only
  to find the bookmarked episode's audio enclosure. Deepmarks does not
  archive a whole feed or queue other episodes from that feed.
- **Always private:** the downloaded media file is always encrypted and
  stored as a private blob, regardless of whether the bookmark/page URL
  is public. Only the npub that bookmarked the URL receives the archive
  record and the self-encrypted decrypt key. Deepmarks should not
  publicly redistribute media bytes.
- **Watching/downloading:** the buyer uses the bookmark row's archive
  action menu. The archive icon opens play and download actions. Play
  fetches the encrypted blob, decrypts it client-side with the buyer's
  archive key, and on web renders it inline (`<video>` / `<audio>` /
  `<img>`) with native media controls. On iOS and Android shells, play
  opens the decrypted file through the native/WebView media path so the
  device player can handle playback. Download is available from the same
  menu on web and mobile. Because the bytes are encrypted, the raw
  Blossom URL is intentionally *not* viewable on its own — the server
  serves the blob as sandboxed `text/html`, so opening the hash directly
  shows a blank page. Media is therefore only ever watched through the
  in-app decrypt path. MKV fallbacks that browsers cannot decode inline
  steer the buyer to download the file and watch it on their device.
- **Provider blocks:** hosted media extraction is only as good as the
  upstream provider permits from the worker. YouTube bot checks, removed
  videos, private videos, Reddit auth walls, and unsupported legacy URLs
  are treated as terminal media-job failures rather than retried for
  days. Operators may mount a read-only `YTDLP_COOKIES_FILE` on Box B for
  yt-dlp, but that is an operator credential choice, not a user-account
  feature, and it does not guarantee extraction.

## Sharing and redistribution

The goal is that Deepmarks never distributes the multimedia file to anyone
other than the buyer who archived it, for their own personal use. The
design enforces this for every link a buyer could share:

- **Blossom hash URL:** what lands at `blossom.deepmarks.org/<hash>` is the
  AES-256-GCM ciphertext. Anyone can fetch it, but the decrypt key is
  per-user and lives only in the buyer's self-encrypted NIP-51 archive-key
  set, so a shared hash is undecryptable noise to everyone else — and the
  server returns it as sandboxed `text/html`, i.e. a blank page. Even
  another media add-on buyer cannot decrypt it.
- **In-app player URL:** the inline web player and native open handoff
  point at a `blob:` object URL that is origin- and session-scoped to the
  buyer's own browser/app session. Pasted anywhere else it is a dead link.
- **Downloaded file:** once the buyer downloads the decrypted file it is a
  plain personal copy on their device. Deepmarks applies no DRM, so what
  the buyer does with their own copy past that point is their
  responsibility — the same as any download. Deepmarks itself only ever
  stores and serves ciphertext, never plaintext media bytes.

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
6. Box B archive-worker runs direct-file capture, podcast enclosure
   discovery, or `yt-dlp`, encrypts the media with `archiveKey`, uploads
   the ciphertext blob and any sidecars, and POSTs `/archive/callback`.
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
