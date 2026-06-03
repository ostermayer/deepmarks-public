# Deepmarks payment-proxy

Box A Fastify service for Deepmarks. It is the API, publish proxy,
payment webhook receiver, archive coordinator, search/cache surface, and
operator endpoint bundle. It never holds a user's `nsec`; user writes
arrive as signed Nostr events or fresh NIP-98 credentials.

## Responsibilities

- **Server-mediated publish:** `POST /publish` accepts locally signed
  events from web, mobile, and browser extensions, verifies signatures
  and NIP-98 body binding, queues the events for strfry, and lets the
  relay-fanout worker publish to the user's NIP-65 write relays.
- **Account state:** passkey registration, encrypted nsec ciphertext
  storage, synced non-secret settings, username claims, account delete,
  contacts cache, and web-push subscriptions.
- **Search and first paint:** public bookmark cache, Meilisearch public
  search, popular tags, profile lookups, favicon cache, and Atom feeds.
- **Lightning:** Deepmarks-hosted LNURL-pay addresses, NIP-57 zap
  receipts, BTCPay lifetime checkout, BTCPay media add-on checkout, and
  settlement reconciliation.
- **Archives:** lifetime archive enqueue, default archive queueing from
  `/publish`, media archive add-on queueing, archive-worker callbacks,
  archive records, refcounts, and Blossom write auth.
- **Operations:** admin endpoints, health, alerter, reports/moderation
  intake, and background workers.

Operational Nostr signing is delegated to Box C (`bunker/`) over NIP-46.
The payment host has only an ephemeral bunker client key; it does not
store brand/admin/social nsecs.

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
npm test
npm run typecheck
```

Local dev needs Redis. Lightning, BTCPay, S3, Meilisearch, and bunker
settings can be stubbed or left disabled depending on the flow being
tested; `.env.example` documents the optional/required variables.

## Module map

| Area | Files |
|---|---|
| Bootstrap / deps | `index.ts`, `bootstrap.ts`, `route-deps.ts`, `workers-bootstrap.ts` |
| Auth | `auth.ts`, `helpers/auth-gate.ts`, `helpers/rate-gate.ts`, `helpers/assert-token.ts` |
| Publish / relays | `routes/publish.ts`, `workers/relay-fanout.ts`, `relay-helpers.ts`, `registry.ts` |
| Account | `routes/account.ts`, `routes/passkey.ts`, `routes/ciphertext.ts`, `account.ts`, `passkey.ts`, `ciphertext.ts`, `user-settings.ts`, `username.ts` |
| API v1 | `routes/api-v1.ts`, `api-keys.ts`, `api-helpers.ts` |
| Archives | `routes/archive.ts`, `archive-purchase.ts`, `archive-dedupe.ts`, `archive-lifecycle.ts`, `archive-refcount.ts`, `safe-url.ts`, `mirror-urls.ts` |
| Blossom / blobs | `routes/blossom-auth.ts`, `blossom-auth.test.ts`, `blossom-blob-store.ts` |
| Media add-on | `routes/youtube-archive.ts`, `video-archive.ts`, `media-archive-addon.ts`, `youtube.ts` |
| Lightning | `routes/lnurl.ts`, `routes/lifetime.ts`, `btcpay.ts`, `voltage.ts`, `lnurl.ts`, `invoice-handler.ts`, `purchase-settlement.ts` |
| Search / feeds | `routes/search.ts`, `routes/public-bookmarks.ts`, `routes/popular-tags.ts`, `feed/*`, `search.ts`, `public-bookmark-cache.ts` |
| Metadata | `routes/metadata.ts`, `routes/favicon.ts`, `metadata.ts`, `favicon.ts`, `profile.ts`, `routes/profile.ts`, `routes/private-marks.ts` |
| Push / contacts | `routes/web-push.ts`, `web-push.ts`, `routes/contacts.ts`, `workers/follows-ingester.ts` |
| Admin / moderation | `routes/admin*.ts`, `routes/relay-checks.ts`, `reports.ts`, `routes/reports.ts`, `blocklist.ts`, `alerter.ts` |
| Bunker / ops signing | `signer.ts`, `frontend-url.ts`, `seed/*` |

## Primary endpoints

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `POST` | `/publish` | Accept signed Nostr events for relay publish/fanout | NIP-98 + signed event |
| `GET` | `/health` | Liveness | none |
| `GET` | `/metadata` | Fetch page metadata for save forms and friends-link previews; YouTube uses cached oEmbed before falling back to generic page fetch | none/rate-limited |
| `GET` | `/favicon` | Cached favicon resolver | none/rate-limited |
| `GET` | `/search/public` | Meilisearch public bookmark search | none/rate-limited |
| `GET` | `/bookmarks/public` | Public bookmarks for one pubkey | none |
| `POST` | `/bookmarks/public` | Fast cache/index write-through for a signed public bookmark | signed event |
| `GET` | `/tags/popular` | Public popular tag list | none |
| `GET` | `/profile/:pubkey` | Profile metadata cache, including Lightning address fields | none |
| `GET` | `/feed/*.xml` | Atom feeds for recent/network/popular/tags/users | none |
| `POST` | `/account/lifetime` | Create BTCPay lifetime checkout | NIP-98 |
| `POST` | `/btcpay/webhook` | BTCPay settlement callback | BTCPay HMAC |
| `GET` | `/account/lifetime/status` | Public lifetime status for a pubkey | none |
| `GET`/`PUT` | `/account/settings` | Synced non-secret settings | NIP-98 |
| `GET` | `/account/contacts` | Contact-list autocomplete/cache | NIP-98 |
| `POST` | `/account/passkey/*` | Passkey challenge/register/assert flows | mixed; register is NIP-98 |
| `POST`/`DELETE` | `/account/nsec-ciphertext` | Store/remove passkey-encrypted nsec ciphertext | NIP-98 |
| `GET` | `/account/nsec-ciphertext` | Fetch ciphertext after fresh passkey assertion | assertion token |
| `POST`/`DELETE` | `/account/username` | Claim/release short handle | NIP-98 + lifetime |
| `DELETE` | `/account` | Account deletion/tombstone cleanup | NIP-98 |
| `POST` | `/archive/lifetime` | Enqueue webpage/PDF/audio archive | NIP-98 + lifetime |
| `GET` | `/account/archives` | List completed archives | NIP-98 |
| `DELETE` | `/account/archives/:blobHash` | Remove one archive record/blob where allowed | NIP-98 |
| `GET` | `/account/archive-queue` | Pending/running archive counts | NIP-98 |
| `POST` | `/archive/callback` | Archive-worker completion/failure callback | worker HMAC |
| `GET` | `/archive/status/:hash` | Poll legacy/current job status | none |
| `GET`/`POST` | `/add-on/video-archive/*` | Legacy-named media archive add-on status/checkout/enqueue | NIP-98 |
| `GET` | `/blossom/check-auth` | Caddy forward-auth for Blossom writes | BUD-01 event |
| `GET` | `/.well-known/lnurlp/:name` | LNURL-pay metadata | none |
| `GET` | `/lnurlp/:name/callback` | Zap/LNURL invoice creation | none |
| `GET`/`POST`/`DELETE` | `/api/v1/*` | Lifetime API key and bookmark/archive API | NIP-98 or Bearer |
| `GET`/`POST` | `/admin/*` | Operator actions and diagnostics | NIP-98 + `ADMIN_PUBKEYS` |
| `POST` | `/web-push/subscribe` / `/web-push/unsubscribe` | Web push subscription management | NIP-98 |
| `POST` | `/report` | Public abuse report intake | none/rate-limited |

See [`../docs/api-v1.md`](../docs/api-v1.md),
[`../docs/relay-policy.md`](../docs/relay-policy.md),
[`../docs/lightning.md`](../docs/lightning.md), and
[`../docs/archives.md`](../docs/archives.md) for protocol-level detail.

## NIP-98 requirements

NIP-98 routes expect `Authorization: Nostr <base64-json-event>` where the
event is `kind:27235`, signed by the caller's pubkey, fresh within 60
seconds, and bound to the exact request URL and method:

```json
{
  "kind": 27235,
  "tags": [
    ["u", "https://api.deepmarks.org/publish"],
    ["method", "POST"],
    ["nonce", "<random>"],
    ["payload", "<sha256(body) hex>"]
  ],
  "content": ""
}
```

Body-bearing routes pass the raw body into the auth gate and therefore
require the `payload` tag. The verifier also single-uses the auth event
id in Redis for 65 seconds, which blocks replay inside the freshness
window.

`POST /publish` has two signatures to verify:

1. The NIP-98 event proves the HTTP caller controls the pubkey and binds
   the request body.
2. Every event in `body.events[]` must be a valid Nostr event signed by
   the same pubkey.

## Background workers

Started from `workers-bootstrap.ts` after Fastify listens:

- `relay-fanout` drains `/publish` work to strfry and fans stored events
  to each author's NIP-65 write relays. Most user `kind:1` cross-posts
  are fanout-only; watched friends' link-containing notes are stored so
  `/app/friends` can render the links without social commentary.
- `onboarding-scanner` imports a new user's existing bookmark-shaped
  events from their relay list.
- `lifetime-archive-backfill` queues an initial archive batch when a
  pubkey becomes lifetime.
- `save-count-tracker`, `zap-listener`, and `profile-resolver` maintain
  search/ranking/profile caches.
- `follows-ingester` keeps contact-list-derived views current.
- `pinboard-seeder` publishes the daily public-profile bookmark/social
  post through the bunker-backed public signer.

## Payment and archive flow

Lifetime and add-on products use BTCPay hosted checkout. BTCPay is the
ledger of record; Redis and NIP-32 labels are derived state. Settlement
webhooks are verified with HMAC, then the invoice is re-read through the
BTCPay API before lifetime or media add-on entitlement is stamped.

Archive jobs are entitlement-gated before they reach Box B. The worker
uploads bytes to Blossom and calls `/archive/callback`; payment-proxy
validates the callback HMAC, checks the callback against queued job
metadata, records the archive under the owner pubkey, updates refcounts,
and exposes it through `/account/archives`.

## Secrets and boundaries

- User nsecs are never sent to this service.
- Passkey nsec ciphertext is stored encrypted; payment-proxy cannot
  decrypt it.
- Operational Nostr nsecs live on Box C only. Payment-proxy requests
  bunker signatures over NIP-46 for zap receipts, lifetime labels, and
  public-profile automation.
- The Voltage macaroon is invoice-only. It can create/read invoices but
  cannot spend funds or manage channels.
- BTCPay API keys should be scoped to invoice creation/read operations
  needed by checkout and reconciliation.
- Blossom writes are restricted by Caddy forward-auth and blossom-server
  allowlist to the archive-worker pubkey.

## Verification

```bash
npm run typecheck
npm test
```

The current suite covers NIP-98 auth, API v1, BTCPay metadata/signature
handling, lifetime state, URL safety, search helpers, public feeds,
Blossom auth, archive lifecycle/refcounts, media archive normalization,
LNURL/zap validation, and worker helpers.
