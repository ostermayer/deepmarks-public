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

- saving a new bookmark
- editing an existing bookmark
- using the browser extension archive flow
- calling the lifetime-only API

The web app enqueues with `POST /archive/lifetime` using NIP-98 auth.
The API path uses `POST /api/v1/archives` with a lifetime-issued API key.

When a pubkey becomes lifetime, payment-proxy starts a best-effort
backfill for that pubkey's existing public bookmarks so old saves enter
the archive queue without the user opening each one. The web return
path also enables archive-by-default in synced settings for future
saves. Existing private bookmarks require the user's browser signer for
per-archive encryption keys, so the web app and first-party extension
queue those client-side when the signer is unlocked.

Normal bookmark rows show a small archive icon only after a completed
archive exists. Public archive icons open the Blossom HTML snapshot;
private archive icons decrypt in the browser first. Pending or running
jobs do not render as row badges.

`/app/bookmarks?view=archived` shows completed archives, server
queued/running jobs, local jobs queued by older app versions, and
bookmarks still waiting to queue. The completed source of truth is
`/account/archives`; server backlog comes from
`/account/archive-queue`; a bookmark's `archive-tier` tag is archive
intent, not proof that the worker has shipped the snapshot. This avoids
hiding private-import progress behind a false "archived" state.

## Worker Flow

`payment-proxy` pushes an archive job into Redis at `dm:archive:queue`.
Box B's `archive-worker` pulls from the queue with a crash-safe BLMOVE
handoff into `dm:archive:processing:<workerId>`, renders the page with
Playwright + SingleFile, uploads the result, and calls back to
`payment-proxy`.

Private archives are encrypted before upload with AES-256-GCM using a
browser-generated key. The key is stored in the user's encrypted
`deepmarks-archive-keys` NIP-51 set. Public archives are plaintext and
can be mirrored freely.

## Blossom Fanout

Archives are stored on Deepmarks' Blossom server and mirrored to default
backup Blossom servers. Users can add their own trusted or paid Blossom
servers from settings. Those user-supplied mirrors are included on new
archive jobs.

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
