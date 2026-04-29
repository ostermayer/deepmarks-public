# deepmarks archive worker

The Box B service. Pulls paid archive jobs off the Redis queue, produces standalone HTML archives (Wayback first, Playwright + SingleFile fallback), encrypts private-tier blobs client-side with a per-archive key, uploads to our primary Blossom server, and notifies the payment-proxy to handle mirror fanout + account bookkeeping.

See Flow O in `deepmarks-architecture.html` for the full design.

## Layout

```
src/
  index.ts     — entrypoint, env parsing, graceful shutdown
  worker.ts    — main loop, job processing, retry logic
  queue.ts     — Redis queue client (BLPOP, heartbeat, done records)
  wayback.ts   — Wayback Availability API + snapshot fetch
  renderer.ts  — Playwright + SingleFile page renderer
  crypto.ts    — AES-256-GCM for private-tier encryption
  blossom.ts   — BUD-01 signed upload + BUD-04 mirror client
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

## Deployment

Container runs on Box B (Linode Dedicated 4GB). The Dedicated CPU plan is important — shared-CPU plans throttle mid-render and break Playwright's timing budgets.

```sh
docker build -t deepmarks/archive-worker .
docker run -d --env-file .env --restart unless-stopped deepmarks/archive-worker
```

## Environment variables

See `.env.example`. Key ones:

- `ARCHIVE_WORKER_NSEC` — the worker's Nostr identity. Pubkey must appear in blossom-server's `WRITE_ALLOWLIST_PUBKEYS`.
- `REDIS_URL` — private VPC IP of Box A, usually `redis://10.0.0.5:6379`.
- `MAX_CONCURRENT_JOBS` — parallel job-processing loops per worker container. Default 4; Playwright memory is the bottleneck.
- `WAYBACK_MAX_AGE_DAYS` — if Wayback has a snapshot newer than this, pull it instead of rendering. Default 90.

## Job retries

Three attempts with a 1-min / 5-min / 30-min backoff schedule. Retryable failures (timeouts, 5xx, network errors) are re-queued with incremented attempt count. Permanent failures (4xx, unsupported content type) are finalized immediately and trigger a keysend refund via the payment-proxy callback.

## Operating notes

- **Memory watch** — each Playwright context holds ~150-250 MB of Chromium state during a render. With `MAX_CONCURRENT_JOBS=4`, budget ~1 GB for peak rendering load plus 300 MB for Node runtime.
- **Context isolation** — every job gets a fresh `BrowserContext`. Cookies, storage, cache are never shared across jobs.
- **Private key lifetime** — the per-archive encryption key `K` is held in worker process memory from job receipt through upload completion (~0.5-5s). After `encryptBlob()` returns, the buffer is zeroed best-effort. V8 string pool may retain the base64-encoded key for longer. Documented as the "trust window" in Flow O.

## What this service does NOT do

- No mirror fanout orchestration — reports the blob hash back to payment-proxy, which knows the user's mirror list and issues BUD-04 mirror requests.
- No account updates — payment-proxy writes the archive record in the user's account.
- No Lightning operations — refunds happen via payment-proxy's keysend logic.
- No public HTTP endpoints — workers are not reachable from the internet; they only make outbound calls.
