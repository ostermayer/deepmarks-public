# Deepmarks

> Bookmarks for the open web. A Nostr client for social bookmarking with
> Lightning-funded permanent archives and a programmatic API.

Deepmarks is a bookmarking site in the spirit of del.icio.us and Pinboard,
rebuilt on [Nostr](https://github.com/nostr-protocol/nips) so your data
isn't locked to one operator. Save a URL and it becomes a signed
`kind:39701` event on relays you choose. Tip great links with Lightning
zaps that split to the curator, the site operator, and the Deepmarks
tipjar — three Lightning invoices, no custody. Pay a flat 500 sats to
snapshot a page forever across four independent Blossom mirrors.

If Deepmarks disappears tomorrow, every bookmark you ever saved here is
still readable by any Nostr client, because the events live on relays,
not on our server.

## Status

| Surface          | Typecheck | Tests           | Notes |
| ---------------- | --------- | --------------- | ----- |
| `frontend/`      | ✅ 0 err  | ✅ **185 / 185** | SvelteKit SPA, Cloudflare Pages |
| `payment-proxy/` | ✅ 0 err  | ✅ **214 / 214** | Fastify, hosts LNURL + /api/v1 |
| `archive-worker/`| ✅ 0 err  | ✅ **27 / 27**   | Playwright + SingleFile + BUD-04 |
| `bunker/`        | ✅ 0 err  | ✅ **47 / 47**   | NIP-46 signing service |
| `/api/v1`        | ✅ live   | covered by payment-proxy suite | [API reference](docs/api-v1.md) |

**Combined: 473 passing tests; 0 typecheck errors.**

## How it's built

Four services, three boxes:

- **`frontend/`** — SvelteKit + TypeScript SPA. All Nostr signing happens
  in the browser via [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md)
  extensions, [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md)
  bunker, pasted nsec, or passkey-encrypted nsec storage (WebAuthn +
  PRF, Face ID / Touch ID). Deployed to Cloudflare Pages.
- **`payment-proxy/`** — Fastify API on Box A. LNURL-pay + NIP-57 zap
  receipts, BTCPay webhook, the programmatic `/api/v1`, full-text
  search via Meilisearch, the `/favicon` cache, WebAuthn passkey
  registration + nsec-ciphertext storage. Hosts 4 background workers
  (indexer, zap receipts, save counts, Pinboard seeder).
- **`archive-worker/`** — Node worker on Box B. Dequeues archive jobs,
  renders pages through SingleFile + checks the Wayback Machine, and
  fans the resulting blob out to 4 Blossom mirrors via BUD-04. Private
  archives are AES-256-GCM encrypted client-side.
- **`bunker/`** — NIP-46 signing service on Box C. Holds the Nostr
  secret keys the server needs (for signing zap receipts and brand
  events) so no `nsec` ever lives on the payment host. Permission
  allowlist rejects any event kind outside a small set.

See [`docs/architecture.md`](docs/architecture.md) for the topology
diagram, data flow, Cloud Firewall rules, and where to look when
things break.

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

**Paid per-archive:** 500 sats snapshots a page forever. Public
archives federate across four Blossom mirrors; private archives are
AES-256-GCM encrypted in the browser before upload — the server sees
only ciphertext.

**Lifetime tier (21,000 sats one-time):** unlimited archives +
rotatable `dmk_live_…` API key for programmatic access
([docs](docs/api-v1.md)). Every API write is a pre-signed Nostr event
— the server never holds your `nsec`.

**Zap splits on public bookmarks:** 80% to the curator who saved the
link (via their `lud16`), 10% to the site operator whose page was
bookmarked (when a Lightning address is detectable), 10% to the
Deepmarks tipjar. Nothing is custodial — the wallet pays three
separate Lightning invoices directly.

**Nostr-native identities:** two Lightning addresses are hosted on the
domain — the site tipjar (where the 10% share lands) and the
operator's personal LN address. Each advertises a distinct
`nostrPubkey` per NIP-57; receipts are signed via the signing service
on Box C so no `nsec` ever lives on the payment host.

## What's tested

See each service's README for module-level coverage. Summary:

- **Frontend** — importers (Netscape/Pinboard/Pocket/Instapaper/Raindrop),
  exporters with round-trip proofs, NIP-B0 bookmark builder/parser,
  NIP-44 private-set gates, zap-split math (including fallback paths),
  popularity ranking (saves + zaps × 2, time-window filter, firehose
  quality floor), archive purchase state walk, nsec decoding, API
  client + NIP-98 header round-trip (incl. Unicode), store/theme
  logic.
- **payment-proxy** — NIP-57 `description_hash` exact-JSON rule,
  zap-request validation, session JWT, NIP-98 HTTP auth, LUD-06 LNURL
  shape, URL normalization, API key storage (hash-only, cross-pubkey
  revoke guard, touch coalescing), pre-signed event publish + deletion
  rules, lifetime-member state machine, relay publish/query helpers
  with wedged-relay and timeout paths.
- **archive-worker** — AES-256-GCM round-trip, key-length guard, GCM
  auth failure on one-bit flip, Wayback timestamp + size + freshness,
  BlossomClient BUD-01 auth event with schnorr signature verification.
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

- [`architecture.md`](docs/architecture.md) — three-box topology, data
  flow, persistence, DNS/TLS, Cloud Firewall.
- [`lightning.md`](docs/lightning.md) — Voltage, BTCPay, zap splits,
  archive invoices, lifetime tier, multi-address LNURL.
- [`nostr.md`](docs/nostr.md) — every event kind, NIP compliance,
  identities, bunker-backed signing, citizenship rules.
- [`bunker.md`](docs/bunker.md) — Box C signing service, permission
  model, wire protocol, rotation.
- [`admin.md`](docs/admin.md) — admin auth, CLI, recovery playbooks,
  threat model.
- [`api-v1.md`](docs/api-v1.md) — REST API reference for lifetime-tier
  members.

Design specs (HTML mockups, full roadmap) live in
[`MVP/deepmarks/`](MVP/deepmarks/) and are the immutable product spec —
they describe the system as designed.

## License

MIT.
