# deepmarks archive worker

The Box B service. Pulls lifetime-member archive jobs off the Redis queue, produces standalone HTML archives (Playwright + SingleFile first, Wayback fallback available but production-disabled), encrypts private-tier blobs with a browser-generated per-archive key, uploads to our primary Blossom server, fans out to configured Blossom mirrors, and notifies the payment-proxy for account bookkeeping.

See Flow O in `deepmarks-architecture.html` for the full design.

## Layout

```
src/
  index.ts     — entrypoint, env parsing, graceful shutdown
  worker.ts    — main loop, job processing, retry logic
  queue.ts     — Redis queue client (BLMOVE, heartbeat, done records)
  wayback.ts   — Wayback Availability API + fallback snapshot fetch
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
- `WAYBACK_MAX_AGE_DAYS` — if live rendering fails and Wayback has a snapshot newer than this, use it as the fallback archive source. Code default is 90; production sets `0` so current live renders are required.

## Job retries

Up to five attempts. Retryable failures (timeouts, 5xx, network errors) are re-queued to the back of `dm:archive:queue` with an incremented attempt count. The worker does not sleep on a failed URL; the slot immediately takes the next job so healthy imports keep draining. Permanent failures (4xx, unsupported content type, unsafe URL) are finalized immediately and reported to the payment-proxy callback.

## Operating notes

- **Memory watch** — each Playwright context holds ~150-250 MB of Chromium state during a render. With `MAX_CONCURRENT_JOBS=4`, budget ~1 GB for peak rendering load plus 300 MB for Node runtime.
- **CPU watch** — Docker constrains the production container to 1.5 CPUs on the Dedicated 4GB box. Short bursts above one full core are expected; sustained host-level CPU above that cap means another process is competing or the cap is missing.
- **Queue watch** — `LLEN dm:archive:queue` is pending backlog; `KEYS dm:archive:processing:*` plus `LLEN` on each key is in-flight work recoverable by `recoverOrphans` after restarts.
- **Context isolation** — every job gets a fresh `BrowserContext`. Cookies, storage, cache are never shared across jobs.
- **Private key lifetime** — the per-archive encryption key `K` is held in worker process memory from job receipt through upload completion (~0.5-5s). After `encryptBlob()` returns, the buffer is zeroed best-effort. V8 string pool may retain the base64-encoded key for longer. Documented as the "trust window" in Flow O.

## What this service does NOT do

- No account updates — payment-proxy writes the archive record in the user's account.
- No Lightning operations — archive entitlement is verified before the job reaches this worker.
- No public HTTP endpoints — workers are not reachable from the internet; they only make outbound calls.
