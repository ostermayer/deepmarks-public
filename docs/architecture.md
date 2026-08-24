# Architecture

Deployment layout, services, data flow, and where to look when things
break. This doc is the operator-facing production summary. For a shorter
diagram-first orientation, start with
[`system-overview.md`](system-overview.md).

## Host layout

```mermaid
flowchart TB
  users[Users and clients]
  cf[Cloudflare DNS and Pages]
  web[deepmarks.org static SPA]

  subgraph boxA[Box A: public edge and state]
    caddy[Caddy TLS proxy]
    api[api Fastify API - RUN_WORKERS none]
    workers[4 worker containers: search-indexer, relay-sync, enrichment, payments]
    relay[strfry relay]
    blossom[Blossom server]
    redis[Redis]
    meili[Meilisearch]
    qdrant[qdrant vector store]
    searxng[searxng metasearch]
  end

  subgraph boxB[Box B: archive worker]
    worker[Playwright and SingleFile]
    bgutil[bgutil PO-token provider]
    wg[wg residential-egress sidecar]
    replica[strfry replica]
  end

  subgraph boxC[Box C: signer bunker]
    bunker[NIP-46 bunker]
    nsecs[Operational nsecs]
  end

  voltage[Self-hosted LND (ln.lnzap.org)]
  btcpay[BTCPay Server]
  buckets[Linode Object Storage]
  mirrors[Blossom mirrors]
  publicRelays[User NIP-65 relays]

  users --> cf
  cf --> web
  cf --> caddy
  caddy --> api
  caddy --> relay
  caddy --> blossom
  api --> redis
  api --> meili
  api --> qdrant
  api --> searxng
  api --> relay
  api --> voltage
  api --> btcpay
  api -->|NIP-46 over strfry| bunker
  workers --> redis
  workers --> relay
  workers --> meili
  bunker --> nsecs
  worker --> redis
  worker --> api
  worker --> blossom
  worker --> bgutil
  worker --> buckets
  relay --> replica
  blossom --> buckets
  blossom --> mirrors
  relay --> publicRelays
```

Three Linode VPSes share a private VPC (`10.0.0.0/24`). Box A and Box B
have public IPs; Box C is **SSH-only**, reachable through Box A's
strfry relay for NIP-46 bunker traffic. No operational nsec ever leaves
Box C.

### Box A — API / relay / payments (10.0.0.2)

A single VPS running Docker Compose. Services inside
[`deploy/box-a/compose.yml`](../deploy/box-a/compose.yml):

| Container | Image / build | Port (host) | Purpose |
|---|---|---:|---|
| `caddy` | `deepmarks-caddy:ratelimit` (built from `deploy/box-a/caddy/Dockerfile`, `FROM caddy:2` + the `caddy-ratelimit` plugin) | 80, 443 | TLS termination, reverse proxy to the three subdomains |
| `api` | ../../api | 10.0.0.2:4000 (VPC) | Fastify HTTP app (`RUN_WORKERS=none`): LNURL, zaps, lifetime archive enqueue, BTCPay webhook, /api/v1, /admin, search, `/favicon` cache, `/account/archives` (GET + DELETE). VPC binding lets Box B's archive-worker callback in without going through Caddy. |
| `worker-search-indexer` | ../../api → `deepmarks-api:worker` | — | BookmarkIndexer, ZapReceiptListener, SaveCountTracker |
| `worker-relay-sync` | ../../api → `deepmarks-api:worker` | — | RelayFanout, OnboardingScanner, FollowsIngester, ProfileResolver, PinboardSeeder |
| `worker-enrichment` | ../../api → `deepmarks-api:worker` | — | LlmEnrichment |
| `worker-payments` | ../../api → `deepmarks-api:worker` | — | Lightning invoice listener, lifetime backfill, label recovery |
| `strfry` | ../../deploy/box-a/strfry | 10.0.0.2:7777 (VPC) | Nostr relay with deepmarks.js write-policy plugin; VPC port lets Box C connect for NIP-46 |
| `strfry-stream` | ../../deploy/box-a/strfry | — | `strfry router` streaming events to the Box B replica (`replication` profile; shares the strfry DB volume, needs `pid: "service:strfry"`) |
| `blossom-server` | ghcr.io/hzrd149/blossom-server:master | — | Blossom blob server for archive storage |
| `redis` | redis:7-alpine | 10.0.0.2:6379 (VPC) | session + queue + cache; AOF `everysec` + RDB |
| `meilisearch` | getmeili/meilisearch:v1.10 | — | full-text index for `/search/public` |
| `qdrant` | qdrant/qdrant | — | vector store for semantic / natural-language bookmark search (`qdrant-data` volume) |
| `searxng` | searxng/searxng | — | self-hosted metasearch used by archive rescue to find public mirrors |
| `autoheal` | willfarrell/autoheal | — | restarts any container that reports unhealthy |

The four `worker-*` containers run off the **same image** as `api` (built
from `../../api`, tagged `deepmarks-api:worker`, started with `node
dist/worker.js` and a `WORKER_GROUP`); a code deploy must rebuild + restart
them together with `api`. See [deploy.md](deploy.md#daily-deploy).

Box A also owns the backup/restore-test timers. Redis snapshots and
strfry event exports are uploaded to Object Storage nightly, then
restored into throwaway containers/directories to prove the latest
backup can actually be read. See [backup-restore.md](backup-restore.md).

Caddy's hostname routing (`deploy/box-a/Caddyfile`):

- `api.deepmarks.org` → `api:4000`
- `relay.deepmarks.org` → `strfry:7777`
- `blossom.deepmarks.org` → static archive-storage info page at `/`,
  `blossom-server:3000` for blob reads/writes after `forward_auth` to
  api (only the archive-worker pubkey is allowed to write), and a
  default rate-limited branch (`@blossomHome` exempt) that throttles
  public blob downloads to 120 req/min/IP with 429 on overflow.

Blossom reads are public. Writes pass through Caddy `forward_auth` to
api, which only allows the archive-worker pubkey. Lifetime
members get archive storage through Deepmarks workflows, not direct
Blossom upload access. See [blossom.md](blossom.md).

strfry's write-policy plugin (`deploy/box-a/strfry/deepmarks.js`)
accepts supported Deepmarks kinds from relay-allowed pubkeys in
`dm:registered:pubkeys`. That Redis set is an allowlist for persistence,
not a logged-in-user count; it includes Deepmarks users and followed
curators mirrored by the server-side outbox worker:
profiles (0), contacts (3), deletions (5), mute lists (10000), relay
lists (10002), NIP-51 bookmark/follow lists (10003 / 30000 / 30003 / 30001),
public bookmarks (39701), zap receipts (9735), and bunker messages
(24133).
The admin/operational pubkey (`7cb39c…3800`) additionally gates
lifetime labels (1985), while the public brand/social pubkey
(`2944e9…e2f4`) gets a `TEAM_EXTENDED_KINDS` allowance for social-
shaped activity. User kind:1 cross-posts are accepted through
`/publish` for fanout only and **are not stored by strfry**, with one
exception: notes authored by `dm:contacts:watched` pubkeys that
contain an `http(s)` URL are persisted so `/app/friends` can render
those link-only rows without re-fetching old third-party relays. The
follows-ingester mirrors those notes; the surrounding social text is
not displayed. See [`relay-policy.md`](relay-policy.md).

### Box B — archive worker (10.0.0.3)

Separate VPS, also Docker Compose (`deploy/box-b/compose.yml`). Holds
the archive-worker process and its Playwright/Chromium install. Talks
to Box A's Redis over the private VPC (10.0.0.2:6379). No public
ingress — it renders pages with headless Playwright + SingleFile,
uploads to Blossom mirrors, and callbacks Box A at `/archive/callback`.
A `strfry-replica` container (`10.0.0.3:7777`, VPC-only) also lives
here as a read replica fed by Box A's `strfry-stream` router. The
replica has no compose profile gate — it runs whenever Box B compose
is up. (The `replication` profile belongs to Box A's `strfry-stream`
sidecar.)
On redeploy the archive-worker has a `stop_grace_period` of 150s so
`shutdown()` can drain in-flight renders instead of being SIGKILLed.

Box B also runs a `wg` WireGuard sidecar for a last-ditch **residential
egress** path (some hosts — notably YouTube — bot-wall datacenter IPs).
The archive-worker shares the sidecar's network namespace
(`network_mode: "service:wg"`) and only source-binds egress through the
tunnel for the opt-in retry path; normal traffic (VPC Redis, `/archive/callback`,
Blossom) still uses Box B's own IP. See `deploy/box-b/compose.yml`.

Media stack: yt-dlp (installed in a pip venv) with **deno** as its JS
runtime, plus a **`bgutil-provider`** sidecar that mints the YouTube
PO tokens yt-dlp's bgutil plugin needs for format access. X/Twitter is
captured via the FixTweet API (no credentials) — tweets become
self-contained HTML and tweet video is pulled from the resolved direct
`video.twimg.com` mp4. All video is capped at 720p. See
[`archives.md`](archives.md) for the capture details.

Crash-safe handoff: `takeJob` does a Redis BLMOVE off the main
`dm:archive:queue` into a per-worker `dm:archive:processing:<wid>`
list. If the worker dies between the pop and processing, the job
sits in that per-worker list. On startup `recoverOrphans()` scans
`dm:archive:processing:*` and RPUSHes dead workers' contents back to
the queue. Processing lists whose `dm:archive:active:<wid>` heartbeat
still exists are skipped, so overlapping deploys do not duplicate a
live worker's in-flight archive. A second recovery pass runs shortly
after the active heartbeat TTL, which reclaims jobs from workers that
crashed immediately before restart while their old active key was still
temporarily present.

The worker also runs a bounded archive audit loop. It writes
`dm:archive-audit:last`, advances through `dm:archive-job:*` with a
persisted Redis cursor, and requeues stale public webpage/file jobs from
metadata when no queue, processing, active, done, or completed state
exists. Private/media jobs are not replayed from metadata because their
client-held archive keys are deliberately not persisted.

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

`frontend/static/_redirects` has two rules: a 302
`/.well-known/lnurlp/*` → `api.deepmarks.org` so both
`zap@deepmarks.org` and `dan@deepmarks.org` resolve on the apex
domain, and a 302 `/feed/*` → `api.deepmarks.org/feed/:splat` so the
public Atom/RSS-reader feeds are discoverable at the main site origin.

## Data flow summaries

### Save a public bookmark

```
browser/iOS/Android/extension (signer) ─signs kind:39701─> POST /publish
                                                           │
                                                           ▼
                                                api queue + forward
                                                           │
                                                           ▼
                                               strfry writePolicy plugin
                                                1. kind in ALLOWED_KINDS?
                                                2. author in relay allowlist?
                                                3. rate limit OK?
                                                           │ accept
                                                           ▼
                                                    strfry persists
                                                           │
                                           ┌───────────────┼───────────────┐
                                           ▼               ▼               ▼
                                    indexer (Meili)  cache (Redis)  relay-fanout worker
                                                                           │
                                                                           ▼
                                                              user's NIP-65 write relays
                                                              (nos.lol / damus / primal / …)
```

Server-mediated publish model: the client targets one HTTPS endpoint.
The server writes to `relay.deepmarks.org`, then the fan-out worker
propagates each event to the user's NIP-65 write relays so it appears
on Damus / Primal / nos.lol etc. without the user exposing their IP to
those relays or waiting on flaky third-party relays at save time. The
`/publish` → fan-out drain is crash-safe (same pattern as the archive
queue): the fan-out worker `BLMOVE`s each event into a per-worker
processing list and recovers a dead worker's list on the next boot, so a
hard crash between accepting a save and forwarding it can't silently lose
a 202-acknowledged event. See
[`relay-policy.md`](relay-policy.md) for the relay-allowed-pubkey gate,
fan-out worker, watched-contact ingest, onboarding scanner, and
lifetime-archive backfill.

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
explicit and public-only. Each list view also has a `search` button
(`Cmd/Ctrl-K`) that opens an overlay scoped to that list, filters the
current rows client-side, and renders the matches inside the overlay with
`↑/↓/↵` keyboard navigation plus a `search the network` hand-off to
`/app/search`. See [search.md](search.md).

### Archive a page (lifetime)

```
browser ─POST /archive/lifetime (NIP-98)─> api
                                            │ lifetime-gate: lifetimeStore.isPaid(pubkey)
                                            ▼
                                           dm:archive:queue (Redis)
                                            │  synthetic lifetime:<hex> hash
                                            ▼
archive-worker <────────────────────────────┘
      │ (BLMOVE → per-worker processing list)
      │
      ├─ Render with headless Playwright + SingleFile
      │   (Wayback fallback is used when live render fails and a
      │    fresh-enough snapshot is available)
      ├─ (private tier) AES-256-GCM with browser-supplied key,
      │   key zeroed in worker memory after encryption
      └─ Upload to primary, BUD-04 fanout to mirrors
      │
      └─POST /archive/callback─> api
                                  ├─> dm:archives:<pubkey> record
                                  └─> /account/archive-queue reflects backlog
```

No LND round-trip. `/api/v1/archives` follows the same enqueue path
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
`dan@deepmarks.org` use the api + bunker receipt path.

See [lightning.md](lightning.md#zaps-on-public-bookmarks) for the zap
policy and [bunker.md](bunker.md) for the NIP-46 round-trip used by
Deepmarks-hosted LNURLs.

### Site favicon cache

```
browser ─GET /favicon?host=github.com─> api
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
browser ─POST /account/lifetime (NIP-98)─> api ─> BTCPay Greenfield (createInvoice)
                                                                │
browser ─redirect─> BTCPay checkout (hosted) ─> wallet ─BOLT-11─> BTCPay ──(settle)──┐
                                                                                     │
api <─POST /btcpay/webhook (HMAC)─────────────────────────────────────────┘
   │
   ├─ lifetimeStore.markPaid(pubkey)
   ├─ queue public-bookmark archive backfill for that pubkey
   └─ publishLifetimeLabel — signed via bunker (brand × kind:1985) → relays

BTCPay paid screen ─return button─> /app/bookmarks?upgraded=1
                                         │
                                         └─ web app enables archive-by-default
                                            in synced settings
```

Full flow: [lightning.md](lightning.md#hosted-checkout--lifetime-and-add-ons).

## Services matrix

| Concern | Frontend | Browser extension | api (Box A) | Archive-worker | Bunker | Relays / storage |
|---|---|---|---|---|---|---|
| User auth (Nostr) | passkey / NIP-07 / recovery-key / phone signer / NIP-46 signers | encrypted nsec store + first-party NIP-07 provider for any web app | NIP-98 verify (stateless) | — | — | — |
| Passkey-encrypted nsec | WebAuthn PRF + AES-GCM in browser | password-encrypted local storage, optional | `/account/passkey/*` + `/account/nsec-ciphertext` | — | — | Redis (passkey creds) + Linode bucket (ciphertext) |
| Bookmark publish | client signs kind:39701 or encrypted kind:30003, POSTs signed event(s) to `/publish`; public bookmarks also notify `/bookmarks/public` for indexing | same sign-local + `/publish` path | verifies signed events, queues, forwards to strfry, caches/indexes public bookmarks | — | — | relay.deepmarks.org + fanout to user's NIP-65 write relays |
| Bookmark edit / delete | dialog → replacement event or kind:5 through `/publish` | ⋯ menu → same | forwards signed event(s) to strfry | — | — | relay.deepmarks.org + fanout |
| Bookmark read | Redis/local cache first, then NDK subscribe; private bookmarks merged locally; lists render 50 rows at a time | SimplePool subscribe (public + private merged) | `/bookmarks/public` first-paint cache + relay fanout + Meili | — | — | strfry + public relays |
| Search | `/app/search` searches `ownBookmarks` locally (50-row batches), global toggle calls `/search/public`; each list view's `search` overlay shows live in-overlay matches with `↑/↓/↵` | local popup feed search only | Meilisearch-backed public network search | — | — | local cache + Meili |
| Zap (public) | NIP-57 zap request | NIP-57 zap request | LNURL, receipt via bunker | — | signs kind:9735 | LND + user-declared relays |
| Archive enqueue | NIP-98 lifetime gate | lifetime-gated toggle | lifetime check + queue push | consume `dm:archive:queue` via BLMOVE, render, upload, mirror fanout | — | Blossom + Linode S3 |
| Archive key sync (private) | reads kind:30003 set, decrypts via NDK signer | signs kind:30003 `deepmarks-archive-keys` set and POSTs through `/publish`; reconciles paymentHash stash → blobHash on archived-tab open | forwards signed set to strfry | encrypts blob with key supplied by browser, then zeroes | — | relay.deepmarks.org + fanout |
| Archive delete | row ⋯ menu → DELETE /account/archives/:hash + key purge | row ⋯ menu → same | DELETE drops from `dm:archives:<pubkey>`, deletes primary blobs/thumbs, enqueues mirror delete jobs | consumes `dm:archive:delete:queue` and sends Blossom BUD-01 DELETE to mirrors | — | Linode S3 + Blossom mirrors |
| Profile picture | upload to Blossom + publish kind:0 through `/publish` | image link only (default avatar = pennant.svg) | forwards signed profile event to strfry | — | — | Blossom + relay.deepmarks.org + fanout |
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
| Archive blobs | Blossom mirrors (4 by default) + `deepmarks` Linode bucket | multi-operator fanout |
| Redis / strfry backups | dedicated Linode backup bucket via nightly systemd timers | versioned/object-lock-capable bucket, restored nightly into throwaway containers |
| Site favicons | `deepmarks-favicons` Linode bucket | rebuildable (re-fetches on miss) |
| Lifetime memberships | Redis | BTCPay re-read (primary) + NIP-32 relays (secondary) + nightly S3 RDB (tertiary) |
| Search index | Meilisearch | rebuildable from relays |
| Seed data | strfry DB | snapshot in S3 via box-level backup |
| **Operational signer nsecs** | Box C `/opt/deepmarks-bunker/nsecs/` | operator's 1Password — Box C loss is recoverable by re-provisioning and re-placing the nsecs from backup |

Lifetime has the deepest multi-tier story because losing it means
forgetting who paid us money — see
[admin.md](admin.md#playbooks) for the recovery procedures.

Current Linode Object Storage bucket roles are documented in
[backup-restore.md](backup-restore.md#object-storage-controls). The
short version: `deepmarks` is the user-delete archive blob bucket,
`deepmarks-backups` is the versioned/lifecycle-managed Redis + strfry
backup bucket, `deepmarks-favicons` is rebuildable cache, and
`ciphertext` holds passkey-encrypted nsec recovery blobs.

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
- TCP 6379 from `10.0.0.0/24` — Box B Redis (Box C reaches Box A only on 7777)
- TCP 4000 from `10.0.0.0/24` — archive-worker callbacks
- TCP 7777 from `10.0.0.0/24` — **strfry VPC port** for bunker traffic
- ICMP (all)

The VPC subnet is `10.0.0.0/24`. Traffic between boxes on other ports
is dropped at the firewall, not at the host.

## Dev / deploy

- `./dev.sh` at the repo root launches redis, api,
  archive-worker, and the frontend locally. `./doctor.sh` pre-flights.
- `./deploy/push-deploy.sh` commits, pushes, and runs `deploy.sh` on
  each box. `deploy.sh` on the box is `git pull → docker compose
  build → up -d`. Accepts roles `a | b | c`.
- Cloudflare Pages auto-deploys the frontend on every push to `main` —
  no manual step.

See per-component READMEs for dev setup details:
[frontend/README.md](../frontend/README.md),
[api/README.md](../api/README.md),
[archive-worker/README.md](../archive-worker/README.md),
[bunker/README.md](../bunker/README.md),
[deploy/README.md](../deploy/README.md).
