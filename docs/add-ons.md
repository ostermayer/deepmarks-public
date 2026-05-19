# Add-ons

Paid extras layered on top of the lifetime baseline. Each is a one-time
per-purchase Lightning invoice — no subscriptions, no auto-renew.

The "Add Ons" section in `/app/settings` is where users discover and
buy them. Today there is one add-on (YouTube video archive). The
framework is designed so additional add-ons drop in by adding a route
+ a UI card.

## Archive YouTube videos

- **Price:** 150,000 sats per video. Same price for everyone — lifetime
  members included. The download is materially more expensive than a
  webpage archive (bandwidth, ffmpeg, multi-hundred-MB blob storage).
- **Quality cap:** 720p, enforced by the yt-dlp format selector. Falls
  back gracefully to the best available stream under the cap.
- **Container + codecs:** MKV (Matroska, open) holding VP9 video +
  Opus audio. Both are YouTube's native streams, so yt-dlp stream-
  copies them — no transcode, no quality loss, fast worker time.
- **Always private:** the source URL stays whatever visibility the user
  set on the bookmark (public or private), but the downloaded MP4 is
  always encrypted client-side and stored privately. A public YouTube
  link doesn't justify a public re-host of the bytes.

### Flow

1. User opens `Add Ons → Archive a YouTube video` in `/app/settings`.
2. Frontend parses the URL into the canonical 11-char video id
   (`youtube.com/watch?v=…`, `youtu.be/…`, `youtube.com/embed/…`,
   `youtube.com/shorts/…` all collapse).
3. Frontend generates a fresh AES-256-GCM `archiveKey` and POSTs
   `/add-on/youtube-archive/invoice` with `{ url, archiveKey }`. The
   key is stashed in `localStorage` keyed by the returned
   `paymentHash` so a mid-purchase refresh can still finish the
   archive-key sync after settlement.
4. Server returns a BOLT-11 invoice for 150,000 sats plus a hint
   (`alreadyArchived`) when another user has already paid to archive
   the same canonical video id.
5. Client shows the invoice (copy + native `lightning:` link), polls
   `/add-on/youtube-archive/status/<paymentHash>` every 4 seconds.
6. On settlement, the Voltage subscription on Box A enqueues an
   `ArchiveJob` with `kind: 'youtube'` and `videoId`.
7. Box B archive-worker takes the job, runs yt-dlp at ≤720p (VP9 +
   Opus), muxes into MKV, encrypts with `archiveKey`, uploads the
   encrypted blob to Blossom.
8. Worker POSTs `/archive/callback` with the resolved title, channel,
   and duration. Box A writes the record to `dm:archives:<pubkey>` and
   adds the user to the cross-user refcount set for
   `yt:<videoId>`.
9. Once the client poll sees `done`, it publishes `(blobHash →
   archiveKey)` into the user's NIP-51 archive-keys set so any device
   they sign in on can decrypt.

### Naming

The archive record carries `videoTitle` and `videoChannel` separately
plus the canonical URL. The frontend renders the display name as
`Title — Channel` (em dash, channel after the dash). Only the
11-char video id is shown if yt-dlp couldn't resolve metadata.

### Dedup

The first user to archive a given video pays for the full yt-dlp run.
Subsequent buyers of the same video (same canonical video id):

- Still pay 150,000 sats — the price reflects the per-user value of a
  permanent permission to that bytes, not just the download cost.
- Get an instant archive: the worker reads
  `dm:archive-meta:yt:<videoId>` from Redis (stamped on the first
  successful run with `blobHash`, `videoTitle`, `videoChannel`,
  `videoDurationSeconds`) and short-circuits the download. The
  callback writes the user's record against the existing blob hash
  and adds them to the refcount.

### Deletion safety

`dm:archive-refs:yt:<videoId>` is a Redis SET of every pubkey that
references the underlying encrypted blob. When a user deletes their
YouTube archive:

1. Their entry in `dm:archives:<pubkey>` is removed.
2. They are SREM'd from `dm:archive-refs:yt:<videoId>`.
3. The Blossom blob is only physically deleted when `SCARD` reaches 0.
   With the refcount at >0, the blob is retained — every other user
   that paid to archive that video can still decrypt it with their
   own copy of the archive-key.

The same refcount model applies to webpage archives — see
[`archives.md`](archives.md) for the same-shape refcount key
(`dm:archive-refs:<blobHash>`).

## Adding a new add-on

1. Add a route under `payment-proxy/src/routes/` for the invoice +
   status endpoints. Mirror `routes/youtube-archive.ts` — NIP-98 auth,
   per-pubkey rate limit, `PurchaseStore.create` with a `kind` discrim.
2. Extend `ArchiveJob` (or define a new queue) with whatever the
   worker needs.
3. Add a worker branch on `processJob` so the new `kind` doesn't run
   through the webpage Playwright path.
4. Add a card to `frontend/src/lib/components/AddOnsSection.svelte` +
   a `*Dialog.svelte` for the purchase flow.

Keep all paid add-ons in this doc so the operator has one place to see
what's been monetised.
