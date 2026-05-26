# Run your own Deepmarks instance

This guide is for a new operator who wants to fork Deepmarks and run an
independent instance. It explains what each service does, which servers
you actually need, and how the web app, mobile apps, and browser
extensions point at your infrastructure.

For the current production topology, read this first and then use
[`architecture.md`](architecture.md) and [`deploy.md`](deploy.md) as the
low-level references.

## What you are running

Deepmarks is not one server. It is a set of Nostr-aware clients plus a
small server side that provides search, payments, archives, and hosted
project identities.

| Path | Role |
|---|---|
| [`frontend/`](../frontend) | SvelteKit static app and Capacitor source for iOS/Android. Users sign in here with a Nostr signer, recovery key, passkey-protected nsec, or remote signer. |
| [`browser-extension/`](../browser-extension) | Chrome/Firefox/Safari extension. It can save the current tab and act as a NIP-07 signer for Deepmarks. |
| [`payment-proxy/`](../payment-proxy) | Fastify API. Handles LNURL/zaps, lifetime membership, search, favicon cache, API keys, account settings, passkey ciphertext storage, archive queueing, and archive callbacks. |
| [`archive-worker/`](../archive-worker) | Optional background worker. Renders pages with Playwright + SingleFile, encrypts private archives, uploads blobs, and calls back to the API. |
| [`bunker/`](../bunker) | Optional but recommended NIP-46 signer. Holds operational Nostr secrets away from the API host. |
| [`deploy/`](../deploy) | Docker Compose and provisioning templates for the production box layout. |

The user-owned data model remains Nostr-first. Public bookmarks are
`kind:39701` events. Private bookmark sets use encrypted `kind:30003`
events. Relay lists use `kind:10002`. A user can leave your instance and
keep the same bookmarks if they published them to relays they control or
trust.

## Deployment shapes

### Local development

Use this when you are changing the app or testing the flow on one
machine:

```bash
./doctor.sh
./dev.sh
```

That starts Redis, payment-proxy, archive-worker, and frontend with
local defaults. Use `./dev.sh --web-only` for UI-only work, or
`./dev.sh --no-worker` when you do not need Playwright.

### Minimum public instance: Box A + Box C

This is the practical small production shape when you do not want to run
the archiver yet.

| Server | Public? | Runs |
|---|---:|---|
| Box A | yes | Caddy, payment-proxy, strfry relay, Blossom server, Redis, Meilisearch |
| Box C | SSH/VPC only | bunker NIP-46 signer for operational keys |

In this mode, bookmarking, login, search, relay publishing, settings,
extensions, mobile clients, and hosted LNURL/zap behavior can work.
Archives are not available unless you later add Box B.

Important: the API still has archive routes because the same codebase
supports full Deepmarks. If you do not run `archive-worker`, do not sell
or grant lifetime archive access and do not enable archive-by-default in
your public product. Any archive jobs that reach Redis will remain queued
until a worker is deployed.

You can also run without Box C for a lab or private fork, but then any
server-side signing either has to be disabled or moved onto Box A. The
recommended production model keeps operational nsecs on Box C.

### Full production instance: Box A + Box B + Box C

This is the Deepmarks production shape.

| Server | Public? | Runs |
|---|---:|---|
| Box A | yes | public edge, API, relay, Blossom, Redis, Meilisearch |
| Box B | no inbound | archive-worker with Playwright/Chromium |
| Box C | SSH/VPC only | bunker signer and operational nsecs |

Box B is intentionally a background worker, not a realtime critical path.
It can be CPU-capped so imports and large backlogs drain slowly without
making SSH, deploys, or the API host unusable. The production compose
uses a 1.5 CPU cap on a Dedicated 4 GB host.

## Domains and services

Pick domains before building the apps. A typical fork uses:

| Host | Points to | Purpose |
|---|---|---|
| `example.org` | static hosting / Cloudflare Pages | frontend web app |
| `api.example.org` | Box A Caddy | payment-proxy API |
| `relay.example.org` | Box A Caddy | public WebSocket relay |
| `blossom.example.org` | Box A Caddy | Blossom blob server |

The frontend and native app builds bake these public endpoints from
`frontend/.env`:

```bash
VITE_DEEPMARKS_RELAY=wss://relay.example.org
VITE_BLOSSOM_URL=https://blossom.example.org
VITE_API_BASE=https://api.example.org
VITE_DEEPMARKS_PUBKEY=<your public project pubkey hex>
VITE_DEEPMARKS_SEEDER_PUBKEY=<your public project pubkey hex>
VITE_DEEPMARKS_LN_ADDRESS=zap@example.org
```

If you publish browser extensions or mobile apps, treat these values as
part of your release identity. Users will expect the app, extension,
relay, API, and Blossom server to belong to the same operator.

## Bring up a fork

1. Fork or clone the repository.

   ```bash
   git clone https://github.com/<you>/deepmarks-public.git
   cd deepmarks-public
   ```

2. Choose your public domains and DNS provider.

   The deploy templates assume Caddy terminates TLS on Box A for
   `api`, `relay`, and `blossom`. The web app can be static hosting,
   Cloudflare Pages, or any host that serves the built `frontend/build`
   directory.

3. Choose your Nostr identities.

   You need at least one public project pubkey for branding and curated
   activity. If you run hosted LNURL/zap receipts, lifetime labels, or
   automated brand events, create operational signer keys and keep the
   nsecs on Box C. Never commit nsecs, macaroons, keystores, or populated
   `.env` files.

4. Configure the frontend.

   ```bash
   cd frontend
   cp .env.example .env
   # edit VITE_API_BASE, VITE_DEEPMARKS_RELAY, VITE_BLOSSOM_URL,
   # VITE_DEEPMARKS_PUBKEY, and related public values
   npm install
   npm run build
   ```

5. Configure Box A.

   Copy [`deploy/box-a/.env.example`](../deploy/box-a/.env.example) to
   `deploy/box-a/.env` on the server and fill in the values you actually
   use. For a small instance, leave BTCPay/Voltage fields empty until you
   are ready to offer Lightning flows. Configure Redis, Meilisearch,
   object storage, CORS, passkey relying-party values, and the Box C
   bunker client key.

6. Configure Box C.

   Run [`deploy/box-c/setup-system.sh`](../deploy/box-c/setup-system.sh)
   on the signer host, place operational nsecs in the expected host
   directory, and set `BUNKER_CLIENT_PUBKEY` in
   `deploy/box-c/.env`. See [`bunker.md`](bunker.md).

7. Decide whether Box B exists.

   If you are not offering archives, stop here: do not deploy Box B and
   do not grant lifetime archive access. If you are offering archives,
   configure [`deploy/box-b/.env.example`](../deploy/box-b/.env.example)
   with Redis, callback, worker nsec, Blossom, and concurrency settings,
   then deploy Box B.

8. Deploy services.

   Use [`deploy/README.md`](../deploy/README.md) for provisioning and
   `deploy/deploy.sh` for per-box Docker Compose deploys. A public fork
   should create its own `deploy/.env.local` from the example generated
   by the public export process; do not copy Deepmarks production host
   values.

9. Build app surfaces.

   Web:

   ```bash
   cd frontend
   npm run build
   ```

   Android:

   ```bash
   cd frontend
   npm run build
   npx cap sync android
   ```

   iOS:

   ```bash
   cd frontend
   npm run build:apple
   npx cap sync ios
   ```

   Browser extension packages live in [`browser-extension/`](../browser-extension).
   Update extension names, IDs, host permissions, and endpoint defaults
   before publishing a fork.

## How the apps interface with your boxes

### Web app

The web app is a static client. It does not need a Node server at
runtime. It talks to:

- your relay over WebSocket for Nostr events
- your API over HTTPS for search, account settings, zaps, API keys, and
  archive queue/status
- your Blossom server over HTTPS for archive blobs and media
- third-party relays chosen by the user

All signing is user-side unless the server is signing its own
operational events through Box C.

### Browser extensions

The extension can save the active tab, publish bookmarks, and provide a
NIP-07 signer to your web app. Public Chrome/Firefox/Safari packages
must list the API/web hosts they access in the extension manifest. Keep
the Chrome Web Store permission justifications aligned with the manifest
and the docs in [`extensions.md`](extensions.md).

### iOS and Android apps

The native apps are Capacitor wrappers around the frontend. They use the
same API, relay, and Blossom endpoints as the web build. For your own
release, change:

- Android application ID and signing certificate
- iOS bundle ID, team, signing, and associated domains
- URL schemes / universal links / app links
- `assetlinks.json` and `apple-app-site-association`
- public Nostr project pubkey and endpoint env values

The mobile apps are also intended to become always-available Nostr
signers: Android through NIP-55-style signer integration, and iOS
through secure local key storage plus NIP-46/deep-link flows where
platform constraints allow it. See [`mobile.md`](mobile.md) for current
behavior and release notes.

## Optional dependencies

You can run a useful fork without every production dependency.

| Dependency | If omitted |
|---|---|
| Box B archive-worker | Bookmarks still work. Do not offer archives; any enqueued archive jobs will wait in Redis. |
| BTCPay / Voltage | Bookmarking, search, relay, and app login still work. Lifetime purchases and hosted Lightning invoices are disabled. |
| Box C bunker | User-side signing still works. Hosted operational signing should be disabled or treated as a lab-only Box A secret placement. |
| Own relay | User events can still be signed and sent to `/publish`, but without a canonical relay your search, first-paint cache, onboarding import, and fanout base are weaker. |
| Blossom server | Normal bookmarks work. Archive blobs and Blossom-backed media features should stay disabled. |
| Meilisearch | Personal local search still works in the frontend. Global public search is unavailable or degraded. |

## Security baseline

- Keep user signing in the browser, extension, mobile app, or remote
  signer. The server should not need user nsecs.
- Keep operational nsecs on Box C. Box A should request signatures over
  NIP-46 instead of storing the keys.
- Use an invoice-only Lightning macaroon. Do not put admin macaroons on
  the API host.
- Do not commit `.env`, `.env.local`, `nsec` files, macaroons, Android
  keystores, Apple certificates, provisioning profiles, or private keys.
- Inspect the public export before pushing an open-source mirror. See
  [`release.md`](release.md).

## What to read next

- [`architecture.md`](architecture.md) for the production topology and
  data flows.
- [`deploy.md`](deploy.md) and [`../deploy/README.md`](../deploy/README.md)
  for provisioning and Docker Compose details.
- [`login.md`](login.md), [`mobile.md`](mobile.md), and
  [`extensions.md`](extensions.md) for signer behavior.
- [`bookmarks.md`](bookmarks.md), [`read-later.md`](read-later.md),
  and [`durable-publish.md`](durable-publish.md) for the bookmark
  data model, the `toread` tag convention, and the localStorage
  retry queue that keeps saves durable across flaky networks.
- [`archives.md`](archives.md) for the archive queue, worker flow,
  and chunked archive-keys set.
- [`lightning.md`](lightning.md) and [`bunker.md`](bunker.md) for hosted
  LNURL receipts and server-side Nostr signing.
- [`release.md`](release.md) and [`zapstore.md`](zapstore.md) for public
  source, Android, iOS, and Zapstore release preparation.

## Quick check before you publish

- All five Docker services on Box A are healthy: `caddy`,
  `payment-proxy`, `strfry`, `blossom-server`, `redis`,
  `meilisearch`.
- `strfry.conf` has `maxEventSize >= 524288` so encrypted private
  bookmark chunks and the chunked archive-keys set can land on your
  relay (the default 64 KB silently rejects full chunks).
- The frontend bundle's `VITE_*` env values point at your hosts, not
  the Deepmarks production hosts.
- Capacitor's `contentInset: 'never'` is set in
  `frontend/capacitor.config.ts` for iOS native shell builds (the web
  build ignores it). Required for the bottom tab bar to render
  consistently across routes.
- `/account/archives` returns within a few seconds on a lifetime
  account with many archives. If a single page times out, the
  client expects up to 5000 entries per page — bump server limit if
  you've raised it elsewhere.
