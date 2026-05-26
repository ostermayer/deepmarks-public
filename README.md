# Deepmarks

> Bookmarks for the open web. A Nostr client for social bookmarking with
> Lifetime permanent archives and a programmatic API.

Deepmarks is a bookmarking site in the spirit of del.icio.us and Pinboard,
rebuilt on [Nostr](https://github.com/nostr-protocol/nips) so your data
isn't locked to one operator. Save a URL and it becomes a signed
`kind:39701` event on relays you choose. Tip great links with Lightning
zaps that go directly to the bookmark curator — one Lightning invoice,
no custody. Lifetime members can queue long-tail page snapshots that land
on Deepmarks' Blossom storage and any configured backup Blossom servers.

If Deepmarks disappears tomorrow, every bookmark you ever saved here is
still readable by any Nostr client, because the events live on relays,
not on our server.

## Status

| Surface          | Typecheck | Tests           | Notes |
| ---------------- | --------- | --------------- | ----- |
| `frontend/`      | ✅ 0 err  | ✅ **314 / 314** | SvelteKit SPA, Cloudflare Pages |
| `payment-proxy/` | ✅ 0 err  | ✅ **309 / 309** | Fastify, hosts LNURL + /api/v1 |
| `archive-worker/`| ✅ build  | ✅ **42 / 42**   | Playwright + SingleFile + BUD-04 |
| `bunker/`        | ✅ 0 err  | ✅ **50 / 50**   | NIP-46 signing service |
| `browser-extension/` | ✅ 0 err | ✅ **21 / 21** | Chrome/Firefox/Safari extension |
| `frontend/android` + `frontend/ios` | ✅ synced | local native builds | Capacitor mobile app shells |
| `/api/v1`        | ✅ live   | covered by payment-proxy suite | [API reference](docs/api-v1.md) |

**Combined: 736 passing tests; 0 typecheck errors.**

## How it's built

Four services, three boxes:

- **`frontend/`** — SvelteKit + TypeScript SPA. All Nostr signing happens
  in the browser via [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md)
  extensions, [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md)
  remote signers, Deepmarks mobile phone signer pairing, recovery-key
  paste/QR import, or passkey-encrypted nsec storage
  (WebAuthn + PRF, Face ID / Touch ID). Recovery-key/passkey web sign-ins
  remember the nsec in this browser until logout for refresh/back
  usability; the extension remains the safer daily-use signer. Deployed
  to Cloudflare Pages.
- **`payment-proxy/`** — Fastify API on Box A. LNURL-pay + NIP-57 zap
  receipts, BTCPay webhook, the programmatic `/api/v1`, full-text
  search via Meilisearch, the `/favicon` cache, WebAuthn passkey
  registration + nsec-ciphertext storage. Hosts 4 background workers
  (indexer, zap receipts, save counts, daily Pinboard post).
- **`archive-worker/`** — Node worker on Box B. Dequeues lifetime archive
  jobs, renders live pages through Playwright + SingleFile with Wayback
  as a disabled-by-default fallback, and fans the resulting blob out to
  Blossom mirrors via BUD-04. Private archives are AES-256-GCM encrypted
  with a browser-generated per-archive key before upload.
- **`bunker/`** — NIP-46 signing service on Box C. Holds the Nostr
  secret keys the server needs (for signing zap receipts and brand
  events) so no `nsec` ever lives on the payment host. Permission
  allowlist rejects any event kind outside a small set.

See [`docs/architecture.md`](docs/architecture.md) for the topology
diagram, data flow, Cloud Firewall rules, and where to look when
things break.

## Run your own instance

Deepmarks can be self-hosted as either the full three-box production
shape or a smaller Box A + Box C deployment without the archive worker.
The smaller shape supports bookmarks, search, relay publishing, mobile
apps, browser extensions, and hosted signer/zap operations; archives
should stay disabled until a Box B worker is added.

Start with [`docs/self-host.md`](docs/self-host.md). It explains which
servers do what, which dependencies are optional, how the apps point at
your API/relay/Blossom domains, and what to change before publishing a
fork.

If you are new to the codebase, read
[`docs/getting-started.md`](docs/getting-started.md) first. It gives the
short project map, local run path, publish model, and current mobile
release status.

## Quickest start (local dev)

```bash
./doctor.sh     # pre-flight: node, redis, playwright, .env, open ports
./dev.sh        # boots redis, payment-proxy, archive-worker, frontend
```

Open <http://localhost:5173>. `Ctrl+C` in the terminal stops everything.

Flags:

- `./dev.sh --web-only` — just the frontend (UI tweaks don't need the backends)
- `./dev.sh --no-worker` — skips archive-worker (Playwright + Chromium boot are slow)

## Manual start (per service)

```bash
# Frontend
cd frontend
npm install
cp .env.example .env
npm run dev              # http://localhost:5173
npm test

# Payment-proxy (Box A)
cd ../payment-proxy
npm install
cp .env.example .env     # see file for required vars
npm run dev
npm test

# Archive-worker (Box B)
cd ../archive-worker
npm install
cp .env.example .env
npx playwright install chromium
npm run dev
npm test

# Bunker (Box C — NIP-46 signer)
cd ../bunker
npm install
cp .env.example .env
npm run dev
npm test
```

## Key properties

**Free for anyone:** save, tag, zap, share, import, export. Every public
bookmark is a `kind:39701` event on user-chosen relays — any Nostr
client can read them, and any user can walk away with their data at
zero cost.

**Lifetime tier (21,000 sats one-time):** unlimited archives +
rotatable `dmk_live_…` API key for programmatic access
([docs](docs/api-v1.md)). Every API write is a pre-signed Nostr event
— the server never holds your `nsec`.

**Zaps on public bookmarks:** 100% goes to the curator who saved the
link when their profile exposes `lud16`, `lightning_address`, or
`lud06`. If they do not have a Lightning address/LNURL, the zap goes to
Deepmarks instead. Nothing is custodial — the wallet pays one Lightning
invoice directly.

**Nostr-native identities:** hosted Deepmarks Lightning addresses still
advertise distinct `nostrPubkey` values per NIP-57 for direct zaps and
legacy receipts, with signing routed through the Box C bunker so no
`nsec` ever lives on the payment host.

## What's tested

See each service's README for module-level coverage. Summary:

- **Frontend** — importers (Netscape/Pinboard/Pocket/Instapaper/Raindrop),
  exporters with round-trip proofs, NIP-B0 bookmark builder/parser,
  NIP-44 private-set gates, single-recipient zap planning,
  popularity ranking (saves + zaps × 2, time-window filter, firehose
  quality floor), personal bookmark search, lifetime archive state walk
  and download finalization, nsec decoding, API client + NIP-98 header
  round-trip (incl. Unicode), 50-row list pagination, store/theme logic.
- **payment-proxy** — NIP-57 `description_hash` exact-JSON rule,
  zap-request validation, session JWT, NIP-98 HTTP auth, LUD-06 LNURL
  shape, URL normalization, API key storage (hash-only, cross-pubkey
  revoke guard, touch coalescing), pre-signed event publish + deletion
  rules, lifetime-member state machine, relay publish/query helpers
  with wedged-relay and timeout paths.
- **archive-worker** — AES-256-GCM round-trip, key-length guard, GCM
  auth failure on one-bit flip, Wayback timestamp + size + freshness,
  mirror-target validation, BlossomClient BUD-01 auth event with schnorr
  signature verification.
- **bunker** — NIP-44 round-trip, permission matrix (every identity ×
  kind combination), nsec file loading, full
  decrypt → permission-check → sign → encrypt pipeline, audit log
  shape, unaddressed events silently dropped, undecryptable ciphertext
  marked errored without responding.

## Conventions

- TypeScript strict, ESM, ES2022. `any` is forbidden.
- `nostr-tools` v2 for low-level signing; NDK on the frontend.
- Fastify + zod on backends.
- Lightning: `lightning` npm package, **invoice-only macaroon** (no
  admin macaroon anywhere — a compromised service can't move funds).
- All env reads in one config module per service.
- Honest copy, lowercase where the design mockups are lowercase, no
  hype words.
- Bitcoin-native, self-hosted by default — no AWS, no Stripe, no
  Firebase.

## Documentation

Operator-facing references in [`docs/`](docs):

- [`self-host.md`](docs/self-host.md) — run your own Deepmarks instance,
  optional dependencies, app/service interface, Box A/B/C roles.
- [`getting-started.md`](docs/getting-started.md) — first-read project
  overview, local tutorial, publish model, mobile release status.
- [`architecture.md`](docs/architecture.md) — three-box topology, data
  flow, persistence, DNS/TLS, Cloud Firewall.
- [`deploy.md`](docs/deploy.md) — deploy runbook, health checks,
  rollback, and production gotchas.
- [`relay-policy.md`](docs/relay-policy.md) — server-mediated publish,
  registered relay writes, fanout, and onboarding import.
- [`bookmarks.md`](docs/bookmarks.md) — public/private bookmark model,
  personal library behavior, edit/delete, visibility changes.
- [`search.md`](docs/search.md) — personal search default, global
  search toggle, query modifiers, freshness.
- [`import-export.md`](docs/import-export.md) — import review,
  accurate progress, immediate visibility, export behavior.
- [`archives.md`](docs/archives.md) — lifetime archive UX, worker flow,
  Blossom fanout, downloads.
- [`blossom.md`](docs/blossom.md) — archive-worker-only Blossom storage
  access model and file limits.
- [`add-ons.md`](docs/add-ons.md) — lifetime add-ons, including the
  one-time private media archiver for video/audio bookmarks.
- [`zaps.md`](docs/zaps.md) — bookmark zap recipient selection,
  NWC/invoice paths, receipts.
- [`settings.md`](docs/settings.md) — account/recovery, NWC, relays,
  Blossom backups, lifetime/API controls.
- [`extensions.md`](docs/extensions.md) — browser extension packages,
  signer mode, NWC/WebLN.
- [`mobile.md`](docs/mobile.md) — mobile app behavior and app-store
  payment constraints.
- [`release.md`](docs/release.md) — GPL public mirror and store release
  checklist for web, extensions, iOS, Android, and Zapstore.
- [`releases/v0.6.0.md`](docs/releases/v0.6.0.md) — public release
  notes for the server-mediated publish model.
- [`zapstore.md`](docs/zapstore.md) — Android APK build and Zapstore
  publish checklist.
- [`lightning.md`](docs/lightning.md) — Voltage, BTCPay, curator zaps,
  lifetime tier, multi-address LNURL.
- [`nostr.md`](docs/nostr.md) — every event kind, NIP compliance,
  identities, bunker-backed signing, citizenship rules.
- [`bunker.md`](docs/bunker.md) — Box C signing service, permission
  model, wire protocol, rotation.
- [`admin.md`](docs/admin.md) — admin auth, CLI, recovery playbooks,
  threat model.
- [`api-v1.md`](docs/api-v1.md) — REST API reference for lifetime-tier
  members.

Historical design specs and HTML mockups live in
[`MVP/deepmarks/`](MVP/deepmarks/). Production behavior is documented in
[`docs/`](docs) and the component READMEs.

## License

GPL-3.0-only. See [`LICENSE`](LICENSE).
