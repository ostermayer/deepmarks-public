# Architecture

Deployment layout, services, data flow, and where to look when things
break. Historical design specs live in [`MVP/deepmarks/`](../MVP/deepmarks/);
this doc is the operator-facing production summary.

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
        │       │  holds operational nsecs       │
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
| `payment-proxy` | ../../payment-proxy | 10.0.0.2:4000 (VPC) | Fastify app: LNURL, zaps, lifetime archive enqueue, BTCPay webhook, /api/v1, /admin, search, `/favicon` cache, `/account/archives` (GET + DELETE). VPC binding lets Box B's archive-worker callback in without going through Caddy. |
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
The admin/operational pubkey (`7cb39c…3800`) gates lifetime labels, while
the public brand/social pubkey (`2944e9…e2f4`) gets a
`TEAM_EXTENDED_KINDS` allowance for {0, 1, 3, 6, 7, 10002, 30023} so
social-shaped activity from the Damus-facing identity flows through.
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
RPUSHes the contents back to the queue, so archive jobs can never fall
on the floor.

Separation exists because Playwright's headless Chromium is memory-
hungry and unstable — isolating it from the API process means an
archive crash can't take down `zap@deepmarks.org`.

### Box C — nsec bunker (10.0.0.4)

SSH-only VPS running nothing but the bunker service
(`deploy/box-c/compose.yml`). Holds operational signer nsecs on-disk
(chmod 400, owned by the
`bunker` uid 900 system user) and answers NIP-46 sign requests
delivered through Box A's strfry. Full detail + permission model in
[bunker.md](bunker.md).

Keeping the signer on its own box means a Box A compromise can request
signatures on a narrow kind allowlist (9735 / 1985 / 39701 for the
legacy `brand` signer role,
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
browser (signer) ─signs kind:39701─> NDK pool / extension SimplePool ─> user's write relays
                                      │
                                      └─POST /bookmarks/public (signed event)
                                                   │ verify sig + safety checks
                                                   ├─ publish to relay.deepmarks.org
                                                   └─ write Redis first-paint cache + Meili
```

The bookmark *is* the Nostr event; the server never signs or mutates it.
The write-through step exists only to make the app feel instant after a
save. If the API call fails, relay publication still works. The indexer
also listens to `relay.deepmarks.org` and keeps the same Redis cache warm
for events that arrive by relay fanout.

### Search

```
/app/search?q=term
   │
   ├─ default: browser searches ownBookmarks
   │            ├─ local public cache/API/relay rows
   │            ├─ decrypted private NIP-51 rows
   │            └─ optimistic save/import rows
   │
   └─ with global toggle: GET /search/public?q=term
                         │
                         └─ Meilisearch public kind:39701 index
```

Personal search is the default because it matches user expectation from
the header search bar and includes private bookmarks. Global search is
explicit and public-only. See [search.md](search.md).

### Archive a page (lifetime)

```
browser ─POST /archive/lifetime (NIP-98)─> payment-proxy
                                            │ lifetime-gate: lifetimeStore.isPaid(pubkey)
                                            ▼
                                           dm:archive:queue (Redis)
                                            │  synthetic lifetime:<hex> hash
                                            ▼
archive-worker <────────────────────────────┘
      │ (BLMOVE → per-worker processing list)
      │
      ├─ Render with headless Playwright + SingleFile
      │   (Wayback fallback exists, but production sets max age 0
      │    so current live renders are required)
      ├─ (private tier) AES-256-GCM with browser-supplied key,
      │   key zeroed in worker memory after encryption
      └─ Upload to primary, BUD-04 fanout to mirrors
      │
      └─POST /archive/callback─> payment-proxy
                                  ├─> dm:archives:<pubkey> record
                                  └─> /account/archive-queue reflects backlog
```

No Voltage round-trip. `/api/v1/archives` follows the same enqueue path
because API keys are lifetime-only. See
[lightning.md](lightning.md#lifetime-archives). Archive rows only show a
completed archive icon after `/account/archives` returns a record; pending
backfill state lives in the archived-only progress panel.

### Zap a bookmark (public) — one invoice

```
browser ─wallet.sendPayment(1 invoice)─> curator LNURL endpoint
                                      │   or zap@deepmarks.org fallback
                                      │
                                      └ invoice ← LNURL-pay recipient
                                                       │
                                                  (settle)
                                                       │
                                                       └─> recipient publishes
                                                           kind:9735 receipt to
                                                           user-declared relays
```

Deepmarks does not create a site-operator invoice for bookmark zaps.
When the curator has no Lightning address, the one invoice goes to
`zap@deepmarks.org`. Hosted addresses such as `zap@deepmarks.org` and
`dan@deepmarks.org` use the payment-proxy + bunker receipt path.

See [lightning.md](lightning.md#zaps-on-public-bookmarks) for the zap
policy and [bunker.md](bunker.md) for the NIP-46 round-trip used by
Deepmarks-hosted LNURLs.

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
   ├─ queue public-bookmark archive backfill for that pubkey
   └─ publishLifetimeLabel — signed via bunker (brand × kind:1985) → relays

BTCPay paid screen ─return button─> /app/bookmarks?upgraded=1
                                         │
                                         └─ web app enables archive-by-default
                                            in synced settings
```

Full flow: [lightning.md](lightning.md#lifetime-tier-btcpay-server).

## Services matrix

| Concern | Frontend | Browser extension | Payment-proxy | Archive-worker | Bunker | Relays / storage |
|---|---|---|---|---|---|---|
| User auth (Nostr) | passkey / NIP-07 / recovery-key / NIP-46 signers | encrypted nsec store + first-party NIP-07 provider for any web app | NIP-98 verify (stateless) | — | — | — |
| Passkey-encrypted nsec | WebAuthn PRF + AES-GCM in browser | password-encrypted local storage, optional | `/account/passkey/*` + `/account/nsec-ciphertext` | — | — | Redis (passkey creds) + Linode bucket (ciphertext) |
| Bookmark publish | client signs kind:39701 + write-throughs public events to `/bookmarks/public` | client signs kind:39701 (public) or kind:30003 NIP-51 set entry (private); public saves write-through to `/bookmarks/public` | verifies signed public bookmark, caches, indexes, republishes to our relay | — | — | user's NIP-65 relays + relay.deepmarks.org |
| Bookmark edit / delete | dialog → republish or kind:5 | ⋯ menu → same | — | — | — | user's NIP-65 relays |
| Bookmark read | Redis/local cache first, then NDK subscribe; private bookmarks merged locally; lists render 50 rows at a time | SimplePool subscribe (public + private merged) | `/bookmarks/public` first-paint cache + relay fanout + Meili | — | — | strfry + public relays |
| Search | default searches `ownBookmarks` locally and renders 50 rows at a time; global toggle calls `/search/public` | local popup feed search only | Meilisearch-backed public network search | — | — | local cache + Meili |
| Zap (public) | NIP-57 zap request | NIP-57 zap request | LNURL, receipt via bunker | — | signs kind:9735 | Voltage + user-declared relays |
| Archive enqueue | NIP-98 lifetime gate | lifetime-gated toggle | lifetime check + queue push | consume `dm:archive:queue` via BLMOVE, render, upload, mirror fanout | — | Blossom + Linode S3 |
| Archive key sync (private) | reads kind:30003 set, decrypts via NDK signer | publishes kind:30003 `deepmarks-archive-keys` set after each save; reconciles paymentHash stash → blobHash on archived-tab open | — | encrypts blob with key supplied by browser, then zeroes | — | strfry + public relays |
| Archive delete | row ⋯ menu → DELETE /account/archives/:hash + key purge | row ⋯ menu → same | DELETE drops from `dm:archives:<pubkey>`, deletes primary blobs/thumbs, enqueues mirror delete jobs | consumes `dm:archive:delete:queue` and sends Blossom BUD-01 DELETE to mirrors | — | Linode S3 + Blossom mirrors |
| Profile picture | upload to Blossom + publish kind:0 | image link only (default avatar = pennant.svg) | — | — | — | Blossom + user relays |
| Favicon resolution | `<img>` to /favicon?host | `<img>` to /favicon?host | fetch chain + upload + 302 | — | — | Linode favicon bucket |
| Lifetime upgrade | BTCPay redirect | — (web-only) | BTCPay Greenfield + webhook | — | signs kind:1985 | Redis + BTCPay |
| User settings | `/account/settings` sync for non-secret preferences | same API sync when unlocked | Redis-backed settings store | — | — | localStorage / chrome.storage cache + Redis source of truth |
| Daily Pinboard post | — | — | publishes one popular kind:39701 + matching kind:1 note per day | — | signs kind:39701 + kind:1 as public profile | strfry + public relays |
| Admin ops | — (CLI-driven) | — | NIP-98 + ADMIN_PUBKEYS | — | — | Redis |
| Moderation | — | — | report+action endpoints | — | — | Redis (reports) |

## Persistence

| Data | Where | Durability |
|---|---|---|
| User bookmarks (public) | Nostr relays | durable by replication |
| User bookmarks (private) | chunked kind:30003 sets (`deepmarks-private*`) + Redis ciphertext cache | relay source of truth; cache recomputable |
| Archive blobs | Blossom mirrors (4 by default) | multi-operator fanout |
| Site favicons | `deepmarks-favicons` Linode bucket | rebuildable (re-fetches on miss) |
| Lifetime memberships | Redis | BTCPay re-read (primary) + NIP-32 relays (secondary) + nightly S3 RDB (tertiary) |
| Search index | Meilisearch | rebuildable from relays |
| Seed data | strfry DB | snapshot in S3 via box-level backup |
| **Operational signer nsecs** | Box C `/opt/deepmarks-bunker/nsecs/` | operator's 1Password — Box C loss is recoverable by re-provisioning and re-placing the nsecs from backup |

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
