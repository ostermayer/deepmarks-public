# Architecture

Deployment layout, services, data flow, and where to look when things
break. Design specs (HTML mockups, business model, full roadmap) live
in [`MVP/deepmarks/`](../MVP/deepmarks/) and are authoritative — this
doc is the operator-facing summary.

## Host layout

```
                   Cloudflare (DNS + Pages CDN)
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
  deepmarks.org     api.deepmarks.org   relay.deepmarks.org
  (CF Pages,         (Box A, Caddy)     (Box A, strfry)
   static SPA)                          blossom.deepmarks.org
        │                 │             (Box A, blossom-server)
        │                 │                     │
        │           ┌─────┴─────┐               │
        │           │ payment-  │               │
        │           │ proxy     │               │
        │           │ (Fastify) │               │
        │           └─────┬─────┘               │
        │                 │                     │
        │              Redis  Meilisearch  Strfry (internal + VPC)
        │                 │
        │       ┌─────────┴─────────┐
        │       ▼                   ▼
        │   Voltage            BTCPay Server
        │   (LND gRPC)         (Voltage-hosted)
        │
        │                 Box B (VPC)
        │       ┌───────────────────────────┐
        │       │  archive-worker           │
        │       │  (Playwright + SingleFile)│
        │       └────────────┬──────────────┘
        │                    │
        │          Linode Object Storage
        │          (archive blobs + favicons + nightly Redis snapshots)
        │
        │                 Box C (VPC, SSH-only)
        │       ┌───────────────────────────┐
        │       │  bunker (NIP-46 signer)   │
        │       │  holds brand + personal nsecs  │
        │       └────────────┬──────────────┘
        │                    │ (NIP-46 over strfry on 10.0.0.2:7777)
        │                    └──> payment-proxy requests signatures
        │
        └──> Blossom mirrors (BUD-04 fanout): deepmarks + 3 others
```

Three Linode VPSes share a private VPC (`10.0.0.0/24`). Box A and Box B
have public IPs; Box C is **SSH-only**, reachable through Box A's
strfry relay for NIP-46 bunker traffic. No nsec ever leaves Box C.

### Box A — API / relay / payments (10.0.0.2)

A single VPS running Docker Compose. Services inside
[`deploy/box-a/compose.yml`](../deploy/box-a/compose.yml):

| Container | Image / build | Port (host) | Purpose |
|---|---|---:|---|
| `caddy` | caddy:2 | 80, 443 | TLS termination, reverse proxy to the three subdomains |
| `payment-proxy` | ../../payment-proxy | 10.0.0.2:4000 (VPC) | Fastify app: LNURL, zaps, archive invoices, BTCPay webhook, /api/v1, /admin, search, `/favicon` cache, `/account/archives` (GET + DELETE). VPC binding lets Box B's archive-worker callback in without going through Caddy. |
| `strfry` | ../../deploy/box-a/strfry | 10.0.0.2:7777 (VPC) | Nostr relay with deepmarks.js write-policy plugin; VPC port lets Box C connect for NIP-46 |
| `blossom-server` | ghcr.io/hzrd149/blossom-server | — | Blossom blob server for archive storage |
| `redis` | redis:7-alpine | 10.0.0.2:6379 (VPC) | session + queue + cache; AOF `everysec` + RDB |
| `meilisearch` | getmeili/meilisearch:v1.10 | — | full-text index for `/search/public` |

Caddy's hostname routing (`deploy/box-a/Caddyfile`):

- `api.deepmarks.org` → `payment-proxy:4000`
- `relay.deepmarks.org` → `strfry:7777`
- `blossom.deepmarks.org` → `blossom-server:3000`

strfry's write-policy plugin (`deploy/box-a/strfry/deepmarks.js`)
accepts five event kinds from any pubkey: 39701 (bookmarks), 30003
(NIP-51 sets — used both for private bookmarks and the Phase-2B
`deepmarks-archive-keys` set that maps blob hashes to AES keys), 9735
(zap receipts), 1985 (lifetime labels), 24133 (NIP-46 bunker messages).
The brand pubkey (`7cb39c…3800`) and personal pubkey (`2944e9…e2f4`)
also get a `TEAM_EXTENDED_KINDS` allowance for {0, 1, 3, 6, 7, 10002,
30023} so social-shaped activity from those identities flows through.
Everything else is rejected at the relay layer.

### Box B — archive worker (10.0.0.3)

Separate VPS, also Docker Compose (`deploy/box-b/compose.yml`). Holds
the archive-worker process and its Playwright/Chromium install. Talks
to Box A's Redis over the private VPC (10.0.0.2:6379). No public
ingress — it renders pages with headless Playwright + SingleFile,
uploads to Blossom mirrors, and callbacks Box A at `/archive/callback`.

Crash-safe handoff: `takeJob` does a Redis BLMOVE off the main
`dm:archive:queue` into a per-worker `dm:archive:processing:<wid>`
list. If the worker dies between the pop and processing, the job
sits in that per-worker list. On startup `recoverOrphans()` scans
every `dm:archive:processing:*` (including dead-worker IDs) and
RPUSHes the contents back to the queue, so paid jobs can never fall
on the floor.

Separation exists because Playwright's headless Chromium is memory-
hungry and unstable — isolating it from the API process means an
archive crash can't take down `zap@deepmarks.org`.

### Box C — nsec bunker (10.0.0.4)

SSH-only VPS running nothing but the bunker service
(`deploy/box-c/compose.yml`). Holds the brand (`zap@deepmarks.org`) and
personal (`dan@deepmarks.org`) nsecs on-disk (chmod 400, owned by the
`bunker` uid 900 system user) and answers NIP-46 sign requests
delivered through Box A's strfry. Full detail + permission model in
[bunker.md](bunker.md).

Keeping the signer on its own box means a Box A compromise can request
signatures on a narrow kind allowlist (9735 / 1985 / 39701 for brand,
9735 for personal) but cannot exfiltrate keys, sign kind 1 notes, change
profile metadata, or forge deletions.

### Cloudflare Pages — frontend

Static `adapter-static` build of the SvelteKit app, auto-deployed from
`main` on every push. `frontend/.env.production` bakes in
`VITE_API_BASE=https://api.deepmarks.org` (and equivalents) so the
browser knows where the API lives.

`frontend/static/_redirects` has one rule: 302 `/well-known/lnurlp/*`
to `api.deepmarks.org` so both `zap@deepmarks.org` and
`dan@deepmarks.org` resolve on the apex domain.

## Data flow summaries

### Save a public bookmark

```
browser (signer) ─signs kind:39701─> NDK pool ─> user's NIP-65 write relays
                                              ─> relay.deepmarks.org (if in user's list)
```

We have no server step on the hot path. The bookmark *is* the Nostr
event. payment-proxy's indexer subscribes to relays and writes the
Meilisearch index used by `/search/public` — but that's a read-path
concern.

### Archive a page (paid)

```
browser ─POST /archive/purchase─> payment-proxy ─> Voltage (createInvoice)
                                                  │
browser ─WebLN or NWC pay─> wallet ─BOLT-11─> Voltage
                                         │
                                         └─(settle)─> payment-proxy (invoice-sub)
                                                      │
                                                      └─> dm:archive:queue (Redis)
                                                             │
archive-worker <──────────────────────────────────────────────┘
      │ (BLMOVE → per-worker processing list)
      │
      ├─ Render with headless Playwright + SingleFile
      │   (Wayback fast-path code-disabled by default;
      │    paid archives always do a fresh render)
      ├─ (private tier) AES-256-GCM with browser-supplied key,
      │   key zeroed in worker memory after encryption
      └─ Upload to primary, BUD-04 fanout to mirrors
      │
      └─POST /archive/callback─> payment-proxy
                                  └─> NIP-B7 kind:10063 published from user
```

### Archive a page (lifetime member — free)

```
browser ─POST /archive/lifetime (NIP-98)─> payment-proxy
                                            │ lifetime-gate: lifetimeStore.isPaid(pubkey)
                                            ▼
                                           ARCHIVE_QUEUE (Redis)
                                            │  (synthetic lifetime:<hex> hash)
                                            ▼
                                     archive-worker (same as paid path)
```

No Voltage round-trip. See [lightning.md](lightning.md#free-archives-for-members).

### Zap a bookmark (public) — 80/10/10 split

```
browser ─wallet.sendPayment(3 invoices)─> Voltage / curator LN / operator LN
                                          │
                                          ├ curator invoice ←── LNURL-pay their lud16
                                          ├ operator invoice ← LNURL-pay sniffed lightning:
                                          └ deepmarks invoice ← payment-proxy zap@deepmarks.org
                                                                   │
                                                              (settle)
                                                                   │
                                                                   └─> buildZapReceipt
                                                                       │
                                                                       ├ NIP-46 sign request ─> strfry ─> Box C bunker
                                                                       │                                       │
                                                                       │ (permission-check: brand×9735)       │
                                                                       │                                       │
                                                                       │◄─ signed kind:9735 (brand pubkey) ◄──┘
                                                                       │
                                                                       └─> publishZapReceipt to user-declared relays
```

Same flow for `dan@deepmarks.org`, with the personal signer selected by
matching the zap request's `p` tag against the identity registry.

See [lightning.md](lightning.md#zap-splits-on-public-bookmarks) for the
split math and [bunker.md](bunker.md) for the NIP-46 round-trip.

### Site favicon cache

```
browser ─GET /favicon?host=github.com─> payment-proxy
                                         │
                                         ├ Redis hit → 302 to Linode bucket URL
                                         │
                                         └ Redis miss → try in order:
                                            direct /favicon.ico
                                            homepage <link rel="icon">
                                            Google favicon service
                                            DuckDuckGo favicon service
                                            │
                                            (first MIME-sniffed image wins)
                                            │
                                            └─> upload to deepmarks-favicons
                                                 (Linode Object Storage, public-read)
                                            │
                                            └─> 302 to the public URL
```

All four sources failing writes a 7-day miss marker and redirects to a
pre-uploaded `default.svg`. Server-proxies Google/DDG on miss so those
services don't see per-user browsing taste.

### Lifetime upgrade

```
browser ─POST /account/lifetime (NIP-98)─> payment-proxy ─> BTCPay Greenfield (createInvoice)
                                                                │
browser ─redirect─> BTCPay checkout (hosted) ─> wallet ─BOLT-11─> BTCPay ──(settle)──┐
                                                                                     │
payment-proxy <─POST /btcpay/webhook (HMAC)─────────────────────────────────────────┘
   │
   ├─ lifetimeStore.markPaid(pubkey)
   └─ publishLifetimeLabel — signed via bunker (brand × kind:1985) → relays

browser ─redirect back─> /app/upgrade?done=1 ─poll─> GET /account/lifetime/status
                                                         └─> pennant lights up
```

Full flow: [lightning.md](lightning.md#lifetime-tier-btcpay-server).

## Services matrix

| Concern | Frontend | Browser extension | Payment-proxy | Archive-worker | Bunker | Relays / storage |
|---|---|---|---|---|---|---|
| User auth (Nostr) | NIP-07 / nsec / NIP-46 signers | nsec store + first-party NIP-07 provider for any web app | NIP-98 verify (stateless) | — | — | — |
| Passkey-encrypted nsec | WebAuthn PRF + AES-GCM in browser | password-encrypted local storage, optional | `/account/passkey/*` + `/account/nsec-ciphertext` | — | — | Redis (passkey creds) + Linode bucket (ciphertext) |
| Bookmark publish | client signs kind:39701 | client signs kind:39701 (public) or kind:30003 NIP-51 set entry (private) | — (cache/index only) | — | — | user's NIP-65 relays |
| Bookmark edit / delete | dialog → republish or kind:5 | ⋯ menu → same | — | — | — | user's NIP-65 relays |
| Bookmark read | NDK subscribe (public + private merged) | SimplePool subscribe (public + private merged) | relay fanout + Meili | — | — | strfry + public relays |
| Zap (public) | NIP-57 zap request | NIP-57 zap request | LNURL, receipt via bunker | — | signs kind:9735 | Voltage + user-declared relays |
| Archive purchase | WebLN or NWC invoice pay | NWC built in (paste a `nostr+walletconnect://` URI) | invoice + queue push | consume `dm:archive:queue` via BLMOVE, render, upload | — | Blossom + Linode S3 |
| Archive key sync (private) | reads kind:30003 set, decrypts via NDK signer | publishes kind:30003 `deepmarks-archive-keys` set after each save; reconciles paymentHash stash → blobHash on archived-tab open | — | encrypts blob with key supplied by browser, then zeroes | — | strfry + public relays |
| Archive delete | row ⋯ menu → DELETE /account/archives/:hash + key purge | row ⋯ menu → same | DELETE drops from `dm:archives:<pubkey>` + S3 deleteObject from primary | — | — | Linode S3 (primary only; mirrors retain) |
| Profile picture | upload to Blossom + publish kind:0 | image link only (default avatar = pennant.svg) | — | — | — | Blossom + user relays |
| Favicon resolution | `<img>` to /favicon?host | `<img>` to /favicon?host | fetch chain + upload + 302 | — | — | Linode favicon bucket |
| Lifetime upgrade | BTCPay redirect | — (web-only) | BTCPay Greenfield + webhook | — | signs kind:1985 | Redis + BTCPay |
| Pinboard seeder | — | — | publishes kind:39701 | — | signs kind:39701 | strfry + public relays |
| Admin ops | — (CLI-driven) | — | NIP-98 + ADMIN_PUBKEYS | — | — | Redis |
| Moderation | — | — | report+action endpoints | — | — | Redis (reports) |

## Persistence

| Data | Where | Durability |
|---|---|---|
| User bookmarks (public) | Nostr relays | durable by replication |
| User bookmarks (private) | kind:30003 + Redis ciphertext cache | relay source of truth; cache recomputable |
| Archive blobs | Blossom mirrors (4 by default) | multi-operator fanout |
| Site favicons | `deepmarks-favicons` Linode bucket | rebuildable (re-fetches on miss) |
| Lifetime memberships | Redis | BTCPay re-read (primary) + NIP-32 relays (secondary) + nightly S3 RDB (tertiary) |
| Search index | Meilisearch | rebuildable from relays |
| Seed data | strfry DB | snapshot in S3 via box-level backup |
| **Brand + personal nsecs** | Box C `/opt/deepmarks-bunker/nsecs/` | operator's 1Password — Box C loss is recoverable by re-provisioning and re-placing the nsecs from backup |

Lifetime has the deepest multi-tier story because losing it means
forgetting who paid us money — see
[admin.md](admin.md#playbooks) for the recovery procedures.

## DNS + TLS

- Cloudflare holds DNS. The apex + www are **Proxied** (CF CDN in
  front). Subdomains for api / relay / blossom are **DNS-only** (grey
  cloud) so Caddy's ACME HTTP-01 challenge works.
- Caddy issues + renews certs for all three subdomains on Box A with
  Let's Encrypt.
- `deepmarks.org` A records point at Cloudflare Pages; `api.*`,
  `relay.*`, `blossom.*` point at Box A's public IP. Box C has no DNS —
  reached only by VPC IP or SSH to its public IP.

## Cloud Firewall

A Linode Cloud Firewall (`firewallA`) in front of Box A gates VPC
traffic. Rules allow:

- TCP 22, 80, 443 (all IPv4/IPv6) — SSH + public HTTPS
- TCP 6379 from `10.0.0.0/24` — Box B + Box C Redis
- TCP 4000 from `10.0.0.0/24` — archive-worker callbacks
- TCP 7777 from `10.0.0.0/24` — **strfry VPC port** for bunker traffic
- ICMP (all)

The VPC subnet is `10.0.0.0/24`. Traffic between boxes on other ports
is dropped at the firewall, not at the host.

## Dev / deploy

- `./dev.sh` at the repo root launches redis, payment-proxy,
  archive-worker, and the frontend locally. `./doctor.sh` pre-flights.
- `./deploy/push-deploy.sh` commits, pushes, and runs `deploy.sh` on
  each box. `deploy.sh` on the box is `git pull → docker compose
  build → up -d`. Accepts roles `a | b | c`.
- Cloudflare Pages auto-deploys the frontend on every push to `main` —
  no manual step.

See per-component READMEs for dev setup details:
[frontend/README.md](../frontend/README.md),
[payment-proxy/README.md](../payment-proxy/README.md),
[archive-worker/README.md](../archive-worker/README.md),
[bunker/README.md](../bunker/README.md),
[deploy/README.md](../deploy/README.md).
