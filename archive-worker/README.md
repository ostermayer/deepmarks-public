# Deepmarks archive worker

The Box B service. Pulls lifetime-member archive jobs off Redis,
captures webpages/PDFs/direct media files/media add-on URLs, encrypts
private-tier blobs with a browser-generated per-archive key, uploads to
the primary Blossom server, mirrors to configured Blossom targets, and
notifies payment-proxy for account bookkeeping.

See [`../docs/archives.md`](../docs/archives.md) and
[`../docs/add-ons.md`](../docs/add-ons.md) for the product and queue
model.

## Layout

```
src/
  index.ts          — entrypoint, env parsing, graceful shutdown
  worker.ts         — main loop, job processing, retry logic, callbacks
  queue.ts          — Redis queue client (BLMOVE, heartbeat, done records)
  renderer.ts       — Playwright + SingleFile page renderer
  scholarly.ts      — DOI/full-text PDF detection for scholarly pages
  strip-selectors.ts — per-host cleanup before SingleFile
  direct-file.ts    — direct PDF/media/document downloader for file URLs
  youtube.ts        — yt-dlp / ffmpeg media capture helpers
  safe-url.ts       — SSRF guard for page/file fetches
  mirror-targets.ts — primary + user/default Blossom mirror resolution
  wayback.ts        — Wayback Availability API + fallback snapshot fetch
  crypto.ts         — AES-256-GCM for private-tier encryption
  blossom.ts        — BUD-01 signed upload + BUD-04 mirror client
```

## Running locally

```sh
cp .env.example .env
# set ARCHIVE_WORKER_NSEC and WORKER_CALLBACK_SECRET
npm install
npx playwright install chromium
npm run dev
```

Requires a Redis instance at `REDIS_URL` and a payment-proxy at `PAYMENT_PROXY_URL` that can accept `POST /archive/callback`.

## Tests

```sh
npm test
npm run build
DEEPMARKS_MEDIA_SMOKE=1 npm run test:media:smoke
npm run test:filetypes:smoke
```

`npm test` covers queue semantics, crypto, Blossom signing, URL safety,
render fallbacks, and media worker behavior with mocked downloads.
`test:media:smoke` runs live direct-file fixtures for image/audio/video/PDF
downloads. `test:media:hosted` also runs seeded yt-dlp simulation against
hosted provider fixtures; pass comma-separated URLs through variables
such as `DEEPMARKS_MEDIA_SMOKE_YOUTUBE_URLS`,
`DEEPMARKS_MEDIA_SMOKE_REDDIT_URLS`, or
`DEEPMARKS_MEDIA_SMOKE_PEERTUBE_URLS`. Hosted platforms are intentionally
opt-in because provider blocks, login walls, and TLS fingerprinting can
fail independently of Deepmarks code.
`test:filetypes:smoke` runs live direct-download checks for every
supported direct-file extension. It uses public sample manifests where
available and can be extended with comma-separated
`DEEPMARKS_FILETYPE_SMOKE_<EXT>_URLS` variables. Use
`npm run test:filetypes:strict` to fail when any extension lacks a real
URL fixture.

## Deployment

Container runs on Box B (Linode Dedicated 4GB). Production compose caps the worker at `cpus: "1.5"` with `MAX_CONCURRENT_JOBS=4` so the host keeps enough headroom for SSH, Redis connectivity, logs, and deploys while the backlog drains. This is intentionally background long-tail preservation, not realtime capture.

```sh
docker build -t deepmarks/archive-worker .
docker run -d --env-file .env --restart unless-stopped deepmarks/archive-worker
```

## Environment variables

See `.env.example`. Key ones:

- `ARCHIVE_WORKER_NSEC` — the worker's Nostr identity. Pubkey must appear in blossom-server's `WRITE_ALLOWLIST_PUBKEYS`.
- `REDIS_URL` — private VPC IP of Box A, usually `redis://10.0.0.2:6379`.
- `MAX_CONCURRENT_JOBS` — parallel job-processing loops per worker container. Default 4; Playwright memory and CPU are the bottlenecks.
- `WAYBACK_MAX_AGE_DAYS` — if live rendering fails and Wayback has a snapshot newer than this, use it as the fallback archive source. Code default is 90; production uses a long rescue window so failed public pages can still be preserved from Wayback.
- `ARCHIVE_AUDIT_INTERVAL_MS` — cadence for the archive audit loop. Set
  to `0` to disable. Production default is 10 minutes.
- `ARCHIVE_AUDIT_MAX_JOBS` / `ARCHIVE_AUDIT_MAX_RUNTIME_MS` —
  per-pass caps for the audit loop. Live queue/processing discovery is
  also bounded inside this window, and the scheduled pass only performs
  direct per-job/per-blob Redis lookups. It does not walk owner-wide
  archive hashes, so `dm:archive-audit:last` stays fresh even when the
  Redis keyspace or archive history is large.
- `MEDIA_ARCHIVE_MAX_BYTES` / `MAX_CAPTURE_BYTES` style limits in env
  and code keep webpage/direct-file/media outputs bounded. Blossom may be
  content-addressed, but the worker still stores actual bytes.

## What gets captured

| Job kind | Capture path | Privacy |
|---|---|---|
| Webpage | Playwright + SingleFile, with per-host strip rules | public or private tier from queued job |
| Direct files | PDF, media, captions, feeds/manifests, ebooks, Office/OpenDocument files, text/CSV/JSON/XML, and common compressed archives via direct downloader after safe-url validation | public or private tier from queued job |
| Podcast episode page | RSS/Atom enclosure discovery, then direct audio download | always private through media add-on |
| Media add-on | direct-file capture or yt-dlp + ffmpeg/remux for supported image/video/audio pages, with best-effort metadata/thumbnail/subtitle sidecars | always private |

Set `YTDLP_COOKIES_FILE` to a read-only cookies.txt path when an operator
intentionally wants yt-dlp to use a signed-in provider session. The
worker only passes the file path through to yt-dlp; it does not manage or
refresh cookies. Keep this as an operator secret and expect providers to
still block or expire sessions.

Scholarly pages that expose DOI metadata and a full-text PDF URL are
captured as a multi-file archive: the normal rendered HTML snapshot is
the primary file and the PDF is stored as a sibling file on the same
archive record. Ordinary webpages with random PDF links do not get this
treatment; the DOI requirement keeps the behavior scoped to article
pages.

Private jobs encrypt with AES-256-GCM before upload. The archive key is
generated by the client and later reconciled into the user's
self-encrypted `deepmarks-archive-keys` set for every blob in the
archive record; payment-proxy and Blossom never receive the decrypt key
as durable plaintext.

## Job retries

Up to five attempts. Retryable failures (timeouts, 5xx, network errors) are re-queued to the back of `dm:archive:queue` with an incremented attempt count. The worker does not sleep on a failed URL; the slot immediately takes the next job so healthy imports keep draining. Permanent failures (4xx, unsupported content type, unsafe URL) are finalized immediately and reported to the payment-proxy callback.

## Operating notes

- **Memory watch** — each Playwright context holds ~150-250 MB of Chromium state during a render. With `MAX_CONCURRENT_JOBS=4`, budget ~1 GB for peak rendering load plus 300 MB for Node runtime.
- **CPU watch** — Docker constrains the production container to 1.5 CPUs on the Dedicated 4GB box. Short bursts above one full core are expected; sustained host-level CPU above that cap means another process is competing or the cap is missing.
- **Queue watch** — `LLEN dm:archive:queue` is pending backlog; `KEYS dm:archive:processing:*` plus `LLEN` on each key is in-flight work recoverable by `recoverOrphans` after restarts.
- **Audit watch** — `GET dm:archive-audit:last` should contain the most
  recent pass summary. A null key means the worker has not started the
  audit loop, cannot write Redis, or is running an old build.
- **Redis clients** — blocking `BLMOVE`/`BLPOP` queue reads use
  dedicated Redis connections. The main worker client is reserved for
  control-plane writes, heartbeats, and archive audit summaries so an
  empty queue cannot starve those commands.
- **Context isolation** — every job gets a fresh `BrowserContext`. Cookies, storage, cache are never shared across jobs.
- **Private key lifetime** — the per-archive encryption key `K` is held in worker process memory from job receipt through upload completion (~0.5-5s). After `encryptBlob()` returns, the buffer is zeroed best-effort. V8 string pool may retain the base64-encoded key for longer; treat that as the archive worker trust window.
- **Archive timestamps** — callbacks include the original bookmark save
  time when provided, so archive sort order can match bookmark order even
  when the worker finishes much later.

## What this service does NOT do

- No account updates — payment-proxy writes the archive record in the user's account.
- No Lightning operations — archive entitlement is verified before the job reaches this worker.
- No public HTTP endpoints — workers are not reachable from the internet; they only make outbound calls.
- No arbitrary Blossom upload service — only queued Deepmarks archive
  jobs can cause uploads.
