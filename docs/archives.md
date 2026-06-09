# Archives

Archiving is a lifetime-member feature. Free users can save, search,
zap, import, and export bookmarks, but archive controls stay hidden or
link to the lifetime upgrade flow.

Archives are background preservation for long-tail availability. They are
not treated as realtime page capture; the UI should make queue state clear
without implying a bookmark is archived before the worker has shipped a
snapshot.

## User Flow

Lifetime users can archive when:

- saving a new bookmark on web, mobile, or the browser extension
- editing an existing bookmark
- using the native share sheet / share extension
- calling the lifetime-only API

Manual archive queues use `POST /archive/lifetime` with NIP-98 auth.
Signed saves that reach `POST /publish` with `archive-tier: forever`
are also queued server-side, so a user can save from a native share
sheet or browser extension and leave without visiting the website. The
API path uses `POST /api/v1/archives` with a lifetime-issued API key.

When a pubkey becomes lifetime, payment-proxy starts a best-effort
backfill for that pubkey's existing public bookmarks so old saves enter
the archive queue without the user opening each one. The web return
path also enables archive-by-default in synced settings for future
saves. Existing private bookmarks require the user's browser signer for
per-archive encryption keys, so the web app and first-party extension
queue those client-side when the signer is unlocked.

Normal bookmark rows show an archive icon once a completed archive
exists. Most archives are a single file: clicking opens the Blossom
snapshot directly for public archives and decrypts in the browser for
private ones. Scholarly pages that expose DOI metadata and a full-text
PDF may produce multiple files for the same archive record, usually the
rendered HTML page plus the PDF. In that case the same row icon opens a
small chooser so the user can pick which file to view. Paid media add-on
archives (video/audio/image) keep the same row archive icon, but on the
buyer's own row it opens a small action menu with play and download.
Play fetches the encrypted blob, decrypts it client-side, and renders it
inline with native media controls on web. On iOS and Android shells it
launches the decrypted file through the native/WebView media path so the
device player can handle playback. Download is available from the same
menu, including on mobile native apps. The raw encrypted Blossom blob is
not opened directly for playback. Their encrypted sidecars (thumbnail,
captions, metadata) are not surfaced in the chooser.
The row's privacy chip (next to the URL) conveys whether the archive is
encrypted. Pending or running jobs do not render as row badges.

The "archives" view is reachable from the section nav tab at the top of
`/app/bookmarks` on web. Native shells suppress the whole section nav
because bottom tabs own mobile navigation; archive access is surfaced on
bookmark rows themselves, so mobile users open private/public archives
from the saved item instead of navigating a dedicated archive tab. The
underlying web URL is
`/app/bookmarks?view=archived`. It shows completed archives, server
queued/running jobs, local jobs queued by older app versions, and
bookmarks still waiting to queue. The completed source of truth is
`/account/archives`; server backlog comes from `/account/archive-queue`;
a bookmark's `archive-tier` tag is archive intent, not proof that the
worker has shipped the snapshot.

Enabling "archive" on a save or edit is a one-tap action — no
confirmation popup. The form publishes the bookmark and fire-and-forget
calls `enqueueArchivePage` so the user can move on while the worker
processes in the background. The blossomHash lands on the row on the
next refresh once the worker callback completes.

The browser extension also exposes an explicit "archive current browser
view" fallback under the archive toggle. When enabled, the extension
serializes the already-loaded tab DOM, strips scripts and inline event
handlers, and queues that HTML as an encrypted private archive through
`POST /archive/browser-capture`. This does not replace the normal server
worker archive; it is for pages the worker cannot fetch because of bot
challenges, login walls, or publisher network restrictions. The capture
is capped at 5 MB and intentionally does not inline every subresource or
download linked files such as PDFs; the standard file/archive worker
continues to handle direct media and document bytes when it can reach
them.

## Worker Flow

`payment-proxy` pushes an archive job into Redis at `dm:archive:queue`.
Box B's `archive-worker` pulls from the queue with a crash-safe BLMOVE
handoff into `dm:archive:processing:<workerId>`, renders the page with
Playwright + SingleFile, uploads the result, and calls back to
`payment-proxy`.
Load-bearing Redis queue transitions use checked pipeline execution:
command-level Redis errors must fail the request/job instead of reading
as success. On terminal worker failures, the worker records
`callbackPending: true` in `dm:archive:done:<jobId>` if Box A does not
accept the `/archive/callback`; the archive audit loop retries that
failure callback and clears the flag after acknowledgement. This keeps
refunds, alerts, and terminal state delivery durable even across a
temporary payment-proxy outage.
Browser-captured private jobs skip the Playwright fetch/render step and
enter at the encrypt/upload/callback stage with `source=rendered`.
Blocking queue reads use dedicated Redis connections; the worker's main
Redis client stays available for heartbeats, audit summaries, and other
control-plane commands even while the archive and delete queues are
empty.

The renderer keeps a single shared Chromium process across jobs but
detects when that process has died (Playwright surfaces it as
"browser has been closed") and respawns transparently. Without this
respawn, a single page that crashes the browser took the whole queue
out — every subsequent job failed for the same reason until the
container restarted. Detection lives in `archive-worker/src/renderer.ts`
behind `ensureBrowser()` / `openContext()`.

Per-host element strip rules clean up obvious noise before SingleFile
runs (the right-rail recommendations on YouTube, the trends-and-Who-
to-follow column on X). A typical YouTube watch page drops from ~60 MB
to ~3–5 MB on disk without losing the player, title, description, or
comments. The map lives in
`archive-worker/src/strip-selectors.ts`; the failure mode is benign
(an unknown host falls back to a vanilla SingleFile capture).

The worker also runs a bounded archive audit loop. Each pass scans
`dm:archive-job:*`, checks per-job completion markers and direct
per-blob account archive entries when a done record is still present,
and writes a summary to
`dm:archive-audit:last` as soon as the pass starts and again when it
finishes. The pass is intentionally capped by job count and runtime so a
large archive history or Redis live-state scan cannot hide audit health
from the dashboard; it does not walk owner-wide archive hashes in the
scheduled worker loop.
When a bounded pass stops early, the worker persists its Redis scan
cursor at `dm:archive-audit:cursor` and resumes from that cursor on the
next pass. This matters once `dm:archive-job:*` grows past the per-pass
cap; otherwise every pass can keep scanning the same first slice and
never reach older stale jobs.
Stale public `webpage` and `file` jobs are replayable from persisted job
metadata, so the audit loop requeues them when they are not queued,
processing, active, completed, or failed. It records short-lived
`dm:archive-audit:requeue:<jobId>` claims to avoid duplicate repair
storms and exposes `requeued` / `requeueDeferred` counters in
`dm:archive-audit:last`.
Private webpage jobs and media jobs are not automatically replayed from
server metadata because their archive keys are intentionally not retained
after queueing. They must re-enter from the signed-in app or browser
extension, where the client can generate and sync a fresh AES key.
Public webpage jobs still get Wayback fallback in the live worker path.

Worker hard caps:

- max captured archive size: **150 MB** (was 50 MB; content-heavy
  pages were bouncing). Pages over the cap are rejected as
  `output_too_large` with category `permanent` so the queue doesn't
  retry forever.
- max chunk plaintext size: 50 KB (private bookmark chunks, see below).

Private archives are encrypted before upload with AES-256-GCM using a
browser-generated key. The key is stored in the user's chunked encrypted
`deepmarks-archive-keys` NIP-51 set (kind:30003, d-tag
`deepmarks-archive-keys` for chunk 0, `deepmarks-archive-keys-N` for
later chunks). While a job is still completing, the client also publishes
the key under `job:<jobId>` so a clean build, app restart, or another
device can recover the key before final blob-hash reconciliation runs.
Multi-file private archives publish the same archive key for every file
blob in the record after completion. See
[the archive-keys section below](#archive-keys-set-chunking). Public
archives are plaintext and can be mirrored freely. Media add-on archives
for image, video, and audio stay private even when the original bookmark
is public.

Direct file URLs bypass browser rendering and preserve the original
bytes. The direct-file path covers PDFs, direct audio/video/image files,
captions/transcripts, RSS/Atom/XML/JSON/text/CSV files, HLS/DASH
manifests, EPUB/MOBI/AZW/CBZ ebooks, Office/OpenDocument files, and
common compressed archives, all under the same 150 MB capture cap.
Public SVG archives are uploaded as `application/octet-stream` so the
bytes are preserved without serving active SVG content inline.
The archive worker has a live `test:filetypes:smoke` suite with named
real-URL fixtures for each supported direct-file extension, plus a
strict mode that fails if any extension lacks fixture coverage.

The media worker first tries direct image/audio/video capture, then
podcast RSS/Atom enclosure discovery, then yt-dlp for hosted media pages
or streaming manifests, including common PeerTube, Reddit, X/Twitter,
Imgur, and video hosts supported by yt-dlp. When yt-dlp exposes metadata
JSON, thumbnails, or English captions/transcripts, those are stored as
encrypted sibling files on the same archive record.
Media capture is best-effort: Deepmarks attempts to archive associated
media on eligible pages, but provider bot restrictions, login walls,
removed media, unsupported players, or extractor limits can prevent a
complete media archive.
Podcast RSS/Atom discovery is episode-scoped: the worker downloads only
the matching audio enclosure for the bookmarked page, or a single
enclosure from a one-episode feed. It does not archive full feeds or
backfill other episodes.
YouTube media eligibility is limited to watch/short/embed-style video
URLs. Search pages, channel pages, and YouTube captcha URLs are not
queued as media archives. Provider auth/bot blocks, removed videos,
private videos, unsupported URLs, and 404 extractor failures are terminal
media-job failures; the worker does not keep retrying them.

## Blossom Fanout

Archives are stored on Deepmarks' Blossom server and mirrored to default
backup Blossom servers. Users can add their own trusted or paid Blossom
servers from settings. Those user-supplied mirrors are included on new
archive jobs.

The Deepmarks Blossom primary is public-read and write-restricted.
Only the Deepmarks archive worker can upload or delete blobs. Lifetime
members get archive storage through Deepmarks bookmark/archive workflows,
not direct Blossom upload access. See [blossom.md](blossom.md).

Blossom is hash-addressed, but hashes do not make arbitrary bytes
operationally harmless. The worker caps webpage/direct-file archives at
150 MB, media add-on yt-dlp blobs at 2 GB, and the Box A Caddy edge
rejects Blossom write request bodies over 2 GB before object storage
sees them.

Deleting an archive removes the account record, deletes Deepmarks'
primary blob/thumbnail, and queues best-effort BUD-01 DELETE requests
for known Blossom mirrors. Full account deletion runs the same cleanup
for every archive owned by that pubkey.

## Downloads

Users can download:

- one archived page from an archived bookmark row
- one file from a multi-file scholarly archive, such as rendered HTML
  or PDF
- one archived media file from a bookmark row's archive action menu
- one archived page from `/app/archives`
- a zip of all completed archives from settings

Private downloads decrypt in the browser or native app before opening or
packaging. Mobile native shells hide ordinary page-download controls, but
keep media downloads visible so a buyer can save the decrypted personal
copy to the device.

## Reliability Notes

The archive queue is the main scaling bottleneck. Current production
runs on Box B with Docker `cpus: "1.5"` and `MAX_CONCURRENT_JOBS=4`.
If many users archive at once, jobs queue instead of running unbounded
browser processes.

Client backfills queue at most 250 missing archives per run and keep a
short local dedupe map so the web app and extension do not repeatedly
enqueue the same URL while workers are still processing earlier jobs.
When `/account/archive-queue` reports outstanding server jobs, the web
app polls about every 30 seconds and waits for the queue to drain before
adding more.

Retryable worker failures are pushed to the back of the Redis queue with
an incremented attempt count. There is no sleeping retry slot, so a single
bad URL cannot occupy one of the limited Playwright workers while healthy
jobs wait behind it.

Operations and payment details live in [lightning.md](lightning.md#lifetime-archives)
and the host topology lives in [architecture.md](architecture.md#archive-a-page-lifetime).

## Archive-keys set chunking

The user's encrypted archive-key map (`{blobHash | job:<jobId> → AES
key}`) is stored as kind:30003 events with NIP-44 v2 encrypted content.
NIP-44 plaintext is capped at ~65 KB, so users with several hundred
archives overflow a single event. The map is chunked across multiple
events with the same shape as the private bookmark set:

| d-tag | Notes |
|---|---|
| `deepmarks-archive-keys` | chunk 0 — always present; carries `dm-set-version` + `dm-set-count` tags when chunking is in play |
| `deepmarks-archive-keys-1` | chunk 1; same version tag |
| `deepmarks-archive-keys-N` | chunk N |

On read, the client fetches chunk 0, reads `dm-set-count`, fetches the
remaining chunks in one `#d` filter, decrypts each, and merges. On
write, the entire map is re-chunked and republished; chunks 1..N are
stamped with a slightly earlier `created_at` than chunk 0 so chunk 0
remains the newest replaceable event for its d-tag and the reader can
treat it as the entrypoint.

Single-chunk users (under ~600 archives) still produce a layout with no
version/count tags so the older single-event readers stay compatible.

## Local stash + reconciliation

When the user enqueues an archive client-side, the AES key is
generated locally and stashed in `localStorage` under
`deepmarks-pending-archive-keys`, keyed by the worker `jobId`. The
client also immediately publishes that key into the chunked NIP-51 set
under `job:<jobId>`. This provisional key is the cross-device recovery
path for the period between job acceptance and archive completion.
`reconcileArchiveKeys` is still called when the user opens
`/app/archives` and from the `my-archives` loader; it promotes stashed
job keys to permanent blob-hash and per-file entries after the archive
list shows a completed record.

If a user opens a private archive (download or in-row preview) before
reconcile has run, the client checks the key map by blob hash, then by
`job:<jobId>`, then falls back to the local stash by `jobId`. This keeps
the user's data decryptable on the device that created it and on other
signed-in devices once the provisional key publish reaches relays.

If a completed private archive record still has no recoverable key after
local stash reconciliation, forced relay refresh, and the browser
extension reconcile bridge, the client treats that record as not yet
openable, but the completed archive record stays visible. Missing-key
state is local repair metadata; it must not hide a public `blossom` tag,
an `/account/archives` row, or an archive icon. Lifetime backfill can
queue a replacement private archive with a fresh client-generated key
even when the user has archive-all disabled. Missing-key replacement
jobs intentionally bypass normal URL dedupe because the old ciphertext
is unrecoverable without its lost AES key. Automatic retries are bounded
per URL (daily cooldown, three attempts across a 14-day window); the
archived-bookmarks view also exposes a manual **retry failed** action
that forces another queue pass for failed and missing-key archive
records.

## Cross-user blob refcount

Archive blobs are content-addressed (SHA-256 of the bytes). Two users
archiving the same URL can share one set of bytes in Blossom when the
rendered output is byte-identical.

Without a refcount, the first user to delete their archive would also
take everyone else's copy with them. The `dm:archive-refs:<blobHash>`
Redis SET tracks every pubkey that references a blob:

- the refcount key is the `blobHash` itself.
- media add-ons also store `videoContentKey` metadata such as
  `yt:<videoId>`, but private video bytes are encrypted with a per-user
  key and are not deduped by source URL.

On archive callback success the worker's owner pubkey is `SADD`'d.
On delete the pubkey is `SREM`'d; the actual Blossom DELETE only fires
when `SCARD` reaches 0.

On first deploy of the refcount module the proxy runs a one-shot
`backfillFromExistingArchives` pass that scans every
`dm:archives:<pubkey>` hash and populates the corresponding ref sets,
so the very first delete after rollout can't unilaterally destroy a
blob another user references.

## Lifetime archive backfill across kinds

The server-side `lifetime-archive-backfill` worker (Box A) pulls
public bookmarks out of two sources when a user first becomes a
lifetime member:

- `kind:39701` (Deepmarks-native public bookmarks) via the
  `dm:public-bookmarks:author:<pubkey>` ZSET indexer cache.
- `kind:10003` (NIP-51 single bookmark list — Damus/Primal/Amethyst's
  "pinned URLs") via a one-shot `r`-tag scan against strfry.

URLs that appear in both kinds dedup so the same archive isn't
queued twice. The worker still caps per-pubkey enqueues at
`MAX_ENQUEUE_PER_PUBKEY` so a heavy importer doesn't starve newer
saves.

## Relay configuration

Worker chunks are large (up to the 50 MB Blossom blob cap and 150 MB
SingleFile output). Archive *keys* and *private bookmark chunks* are
modest but still routinely exceed `strfry`'s default 64 KB event
size. `deploy/box-a/strfry/strfry.conf` raises `maxEventSize` to
**512 KB** so all our addressable encrypted events land on
`relay.deepmarks.org`. Users with smaller libraries never notice; the
cap matters once a chunk is full.
