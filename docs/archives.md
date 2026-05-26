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

Normal bookmark rows show a single archive icon once a completed
archive exists. The same icon shape is used for public and private
archives; the row's privacy chip (next to the URL) conveys whether the
archive's encrypted. Clicking opens the Blossom snapshot directly for
public archives and decrypts in the browser for private ones. Pending
or running jobs do not render as row badges.

The "archives" view is reachable from the section nav tab at the top of
`/app/bookmarks` on web. Native shells suppress that section-nav tab and
surface archive access on the bookmark rows themselves, so mobile users
open private/public archives from the saved item instead of navigating a
dedicated archive tab. The underlying web URL is
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

## Worker Flow

`payment-proxy` pushes an archive job into Redis at `dm:archive:queue`.
Box B's `archive-worker` pulls from the queue with a crash-safe BLMOVE
handoff into `dm:archive:processing:<workerId>`, renders the page with
Playwright + SingleFile, uploads the result, and calls back to
`payment-proxy`.

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

Worker hard caps:

- max captured archive size: **150 MB** (was 50 MB; content-heavy
  pages were bouncing). Pages over the cap are rejected as
  `output_too_large` with category `permanent` so the queue doesn't
  retry forever.
- max chunk plaintext size: 50 KB (private bookmark chunks, see below).

Private archives are encrypted before upload with AES-256-GCM using a
browser-generated key. The key is stored in the user's chunked
encrypted `deepmarks-archive-keys` NIP-51 set (kind:30003, d-tag
`deepmarks-archive-keys` for chunk 0, `deepmarks-archive-keys-N` for
later chunks). See [the archive-keys section below](#archive-keys-set-chunking).
Public archives are plaintext and can be mirrored freely.

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
operationally harmless. The worker caps webpage/PDF/direct podcast-audio
archives at 150 MB, media add-on blobs at 2 GB, and the Box A Caddy edge
rejects Blossom write request bodies over 2 GB before object storage sees
them.

Deleting an archive removes the account record, deletes Deepmarks'
primary blob/thumbnail, and queues best-effort BUD-01 DELETE requests
for known Blossom mirrors. Full account deletion runs the same cleanup
for every archive owned by that pubkey.

## Downloads

Users can download:

- one archived page from an archived bookmark row
- one archived page from `/app/archives`
- a zip of all completed archives from settings

Private downloads decrypt in the browser before opening or packaging.

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

The user's encrypted archive-key map (`{blobHash → AES key}`) is
stored as kind:30003 events with NIP-44 v2 encrypted content. NIP-44
plaintext is capped at ~65 KB, so users with several hundred archives
overflow a single event. The map is chunked across multiple events
with the same shape as the private bookmark set:

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
chunked NIP-51 set is published asynchronously by
`reconcileArchiveKeys` — called when the user opens `/app/archives` and
also from the `my-archives` loader, so any path that fetches the
archive list will promote stashed keys.

If a user opens a private archive (download or in-row preview) before
reconcile has run, the client falls back to the stash by `jobId`. This
keeps the user's data decryptable on the device that created it even
when the relay-side set hasn't published yet — which mattered for the
first 1,747-archive batch where the old un-chunked set was too big to
encrypt at all.

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
