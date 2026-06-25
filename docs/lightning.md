# Lightning on Deepmarks

Bitcoin is the only money we take. Paid flows are zaps and the lifetime
upgrade. Bookmark zaps are not custodial and always use one invoice:
the payer's wallet pays the curator directly when possible, otherwise
it pays Deepmarks.

## Moving parts

| Component | Role |
|---|---|
| **Voltage node** | Our own LND instance. Receives zap payments directly and backs BTCPay. |
| **BTCPay Server** (Voltage-hosted) | Hosted checkout for user-initiated lifetime and add-on purchases. Talks to the same LND node over gRPC. |
| **`payment-proxy`** | Fastify service on Box A. Builds invoices for Deepmarks-hosted LNURL addresses, verifies settlement, signs zap receipts, serves the LNURL-pay endpoint. |
| **`archive-worker`** | Box B. Consumes the lifetime archive queue. Never sees Lightning directly. |

See [architecture.md](architecture.md) for the host-level layout.

## Voltage — direct path

For Deepmarks-hosted LNURL addresses, the payment-proxy talks directly
to Voltage's gRPC endpoint (port **10009**, not the REST 8080) using
the [`lightning`](https://www.npmjs.com/package/lightning) npm package.
Bookmark zaps to outside curators resolve the curator's LNURL endpoint
client-side. If the curator has no Lightning address, the app uses the
Deepmarks-hosted `zap@deepmarks.org` LNURL instead.

### Macaroon scope

We use the **invoice-only macaroon** (`invoice.macaroon`), never admin.
The invoice macaroon's permissions (`invoices:write`, `invoices:read`,
`address:read`, `address:write`, `onchain:read`) are sufficient for:

- creating BOLT-11 invoices
- subscribing to invoice-settlement notifications
- reading the node info we need (alias only)

It cannot move funds, open/close channels, or read the seed. A
compromised Box A means dropped payments, not stolen funds.

`validateVoltageConnection()` sanity-checks the macaroon at boot by
calling `createInvoice` (which exercises `invoices:write`) rather than
`getWalletInfo` (which needs `info:read`, not in the default invoice
macaroon).

That boot check creates a short-lived **1 sat** invoice with description
`deepmarks handshake`. Seeing one such request when `payment-proxy`
starts or is deployed is expected. Seeing a continuous stream of them
means the API process is restarting; check Box A logs for crash traces
before looking for user zap traffic. User zaps go through
`/lnurlp/<name>/callback` and are logged as `zap invoice created` with
`amountMsat`.

### Invoice-settlement worker

`subscribeToInvoices` in payment-proxy fans out settled invoices to
two handlers:

1. **Zap receipts** — if the payment hash matches a pending zap, build
   the NIP-57 receipt and publish to the zap request's declared relays.
2. **Legacy archive invoices** — only for invoices created before
   lifetime-only archiving shipped. If a legacy payment hash matches a
   pending archive, push the job to `ARCHIVE_QUEUE` in Redis.

The `SubscriptionCircuitBreaker` reconnects on transient Voltage
outages without a hot-loop storm.

## LNURL-pay — hosted Deepmarks addresses

We host two Lightning addresses on `deepmarks.org`, each backed by a
distinct Nostr identity:

| Address | `nostrPubkey` | Purpose |
|---|---|---|
| `zap@deepmarks.org` | admin/operational signer (`npub10jeec…`) | Direct Deepmarks zaps, legacy receipts, and bookmark zap fallback when the curator has no Lightning address |
| `dan@deepmarks.org` | optional operator signer | Operator Lightning address, if enabled |

Same LNURL shape for both; different `nostrPubkey`, different signing
identity on settlement. Adding a third address is an env-driven code
change in `payment-proxy/src/index.ts` (`LN_IDENTITIES` map) plus a
new nsec on Box C.

### Wire sequence (either address)

1. Wallet resolves `<user>@deepmarks.org` →
   `https://deepmarks.org/.well-known/lnurlp/<user>`
2. Cloudflare Pages serves the frontend on the apex; `_redirects`
   302s this one path to `https://api.deepmarks.org/.well-known/lnurlp/<user>`
   so the actual LNURL handler runs on Box A.
3. Box A looks up `<user>` in `LN_IDENTITIES`. Unknown → 404. Known →
   returns LUD-06 JSON with `callback` =
   `https://api.deepmarks.org/lnurlp/<user>/callback`, `allowsNostr: true`,
   and `nostrPubkey` = **that identity's** pubkey.
4. Wallet/client calls the callback with
   `?amount=<msat>&nostr=<zap-request>&lnurl=<bech32-pay-url>`.
   The signed kind:9734 zap request must include:
   - `p`: recipient pubkey. For Deepmarks-owned LNURLs this is the
     `nostrPubkey` advertised by LNURL metadata; for curator zaps it is
     the curator pubkey.
   - `lnurl`: the bech32-encoded LNURL pay URL, not the human
     `name@domain` Lightning address.
   - `amount`: the exact millisat amount for that invoice.
5. Payment-proxy verifies the NIP-57 zap request, creates an invoice
   with `description_hash = sha256(<exact zap request JSON bytes>)`,
   and returns the BOLT-11 string.
6. On invoice settlement, the payment-proxy picks the matching signer
   by comparing the zap request's `p` tag against the identity
   registry, sends a NIP-46 `sign_event` request to the Box C bunker,
   and publishes the signed kind:9735 receipt to the relays specified
   in the zap request.

The `description_hash` must be the sha256 of the *exact bytes* the
client sent — no re-serialization. This is a NIP-57 invariant; we have
tests locking it down (`payment-proxy/src/nostr.test.ts`). Signing
happens on the bunker, not on Box A — see [nostr.md](nostr.md#how-the-server-signs-without-holding-keys)
and [bunker.md](bunker.md).

## Zaps on public bookmarks

When a user taps "zap this bookmark" with a sats amount:

- **100%** → the curator who saved the bookmark when their kind:0
  profile has `lud16`, `lightning_address`, or `lud06`
- **100%** → Deepmarks when the curator has no Lightning address

The wallet pays **one invoice** directly to the curator's LNURL
endpoint or to `zap@deepmarks.org`. Nothing is custodial and Deepmarks
does not create a site-operator invoice.

Single-recipient planning + receipt pairing are in
[`frontend/src/lib/nostr/zap.ts`](../frontend/src/lib/nostr/zap.ts)
with round-trip tests in `zap.test.ts`.

## Lifetime archives

Archiving is lifetime-only. The flow:

1. Frontend, browser extension, or `/api/v1` calls `POST /archive/lifetime`
   or `POST /api/v1/archives` after proving lifetime entitlement.
2. Payment-proxy enqueues an `ArchiveJob` with a synthetic
   `lifetime:<hex>` payment hash. No invoice is created.
3. Archive-worker pops via BLMOVE into a per-worker
   `dm:archive:processing:<wid>` list (so a crash mid-render doesn't
   drop the job — `recoverOrphans` on next startup re-queues anything
   left), renders with headless Playwright + SingleFile, uploads to
   Deepmarks' Blossom server, mirrors to Primal plus any user-supplied
   backup Blossom servers, and callbacks `POST /archive/callback` with
   the Blossom hash.
4. The app refreshes `/account/archives` for completed records and
   `/account/archive-queue` for pending/running backlog. Queue depth is
   expected during large imports; archive jobs are preservation work, not
   Lightning-settled realtime delivery.

Private archives are AES-256-GCM encrypted in the archive-worker before
Blossom upload using a key the browser generates and ships once with
the enqueue request. The worker zeroes the plaintext key after encryption;
the browser stashes it locally (chrome.storage.local) AND publishes a
NIP-51 kind:30003 set with `d="deepmarks-archive-keys"` so the same
account can decrypt the snapshot from any signed-in device. Public
archives are plaintext and federate freely.

## Hosted checkout — lifetime and add-ons

Lifetime membership and paid add-ons use BTCPay hosted checkout rather
than direct in-app invoices. BTCPay handles the hosted checkout page
(QR + payment-method fallback + expiry UX + receipt) so we don't
hand-build it.

### Why BTCPay for products

- Bookmark zaps are **direct LNURL payments** to a curator or the
  Deepmarks fallback address. They need a fast inline invoice / QR flow,
  not a hosted checkout redirect.
- Lifetime upgrades and add-ons are **user-initiated products**. The
  user clicks a button, sees a price, and expects an obvious hosted
  checkout. BTCPay's hosted checkout is strictly better than
  re-implementing that UI.

### Flow

1. User signs in and navigates to `/app/upgrade`.
2. Frontend `POST`s `/account/lifetime` with NIP-98 auth (signed by the
   user's nsec). Server creates a BTCPay Greenfield invoice with the
   price in SATS currency and `metadata.deepmarksPubkey = <user-pubkey>`.
3. Frontend redirects the browser to the BTCPay `checkoutLink`.
4. User pays on BTCPay's hosted page. BTCPay settles via its store's
   Lightning connection (our same Voltage node).
5. BTCPay POSTs `InvoiceSettled` to
   `https://api.deepmarks.org/btcpay/webhook`. We verify the HMAC-SHA256
   signature with `BTCPAY_WEBHOOK_SECRET`, re-read the invoice via the
   Greenfield API (second check so a compromised secret still can't
   flag an arbitrary invoice), and if `status === "Settled"` we stamp
   `LifetimeStore.markPaid(pubkey)` + publish the NIP-32 label.
6. BTCPay keeps the paid checkout screen visible with a return button to
   `/app/bookmarks`. The webhook remains authoritative; returning to the
   app is only user-experience sugar.

Media archive add-ons follow the same hosted-checkout shape with
`metadata.deepmarksProduct = "video-archive"`. On settlement, the
webhook verifies the amount and stamps a one-time media archive
entitlement. Future eligible media bookmarks enqueue private encrypted
media archive jobs without another payment.

### Durability

The lifetime record must never be lost — see
[admin.md](admin.md#playbooks) for the operator playbooks. Three layers
in order of primacy:

1. **BTCPay is the ledger.** Reconcile walks its Settled invoice list
   and re-stamps Redis on demand.
2. **NIP-32 labels on relays.** On boot, we query our own labels and
   re-stamp any pubkey Redis is missing.
3. **Nightly Redis RDB → S3.** AOF `everysec` for mid-flight durability,
   nightly `BGSAVE` + sigv4 PUT to Linode Object Storage for
   point-in-time rollback.

### Archive endpoint summary

- `POST /archive/lifetime` (NIP-98, lifetime-gated) → directly enqueues
  an `ArchiveJob` with a synthetic `lifetime:<hex>` payment hash.
- `POST /api/v1/archives` (Bearer API key, lifetime-gated at key mint)
  does the same for scripts and integrations.
- `GET /account/archive-queue` (NIP-98) reports the signed-in user's
  pending/running server backlog.
- No invoice, no WebLN round-trip, no sats transferred.

## Lifetime price escalation

From [`frontend/src/lib/config.ts`](../frontend/src/lib/config.ts):

```ts
const LIFETIME_LAUNCH_DATE = new Date('2026-05-01T00:00:00Z');
const LIFETIME_BASE_SATS = 21000;
const LIFETIME_STEP_SATS = 2500;
```

Every full year past launch adds 2,500 sats. The client runs this math
for display; the server runs the same math when minting the actual
invoice so no one can game their clock.

## Env + secrets at a glance

| Var | Scope | Notes |
|---|---|---|
| `VOLTAGE_REST_URL` | Box A | Host:port for gRPC, e.g. `your-node.m.voltageapp.io:10009` |
| `VOLTAGE_INVOICE_MACAROON` | Box A | hex-encoded, invoice-only |
| `VOLTAGE_TLS_CERT` | Box A | optional; Voltage uses public CAs |
| `BUNKER_CLIENT_NSEC` | Box A | payment-proxy's ephemeral key to the bunker; **not** the brand or personal nsec |
| `BUNKER_RELAY_URL` | Box A | `ws://strfry:7777` (internal docker network) |
| `BUNKER_BRAND_PUBKEY` | Box A | legacy name for the admin/operational signer — advertised as `nostrPubkey` for `zap@` |
| `BUNKER_PERSONAL_PUBKEY` | Box A | legacy personal-role pubkey; production maps this to the public brand/social profile and may also advertise it for the legacy `dan@` LNURL |
| `DEEPMARKS_PUBLIC_BRAND_PUBKEY` / `VITE_DEEPMARKS_PUBKEY` | Box A / frontend | public brand/social pubkey (`npub199z…`) used for NIP-89 and relay social-kind privileges |
| `DEEPMARKS_SEEDER_PUBKEY` / `VITE_DEEPMARKS_SEEDER_PUBKEY` | Box A / frontend | optional override for the daily Pinboard/landing-feed pubkey; defaults to the public brand/social signer (`npub199z…`) |
| `BUNKER_CLIENT_PUBKEY` | Box C | Allowlist — the single client pubkey the bunker will honor sign requests from |
| `BTCPAY_URL` | Box A | BTCPay base URL, e.g. `https://btcpay.example.com` |
| `BTCPAY_STORE_ID` | Box A | the store pointing at our Voltage node |
| `BTCPAY_API_KEY` | Box A | Greenfield key, scoped to `cancreateinvoice` + `canviewinvoices` |
| `BTCPAY_WEBHOOK_SECRET` | Box A | used to verify webhook deliveries |
| `ARCHIVE_WORKER_PUBKEY` | Box A | archive-worker Blossom write key allowed by payment-proxy's dynamic Blossom auth gate |
| `ADMIN_PUBKEYS` | Box A | comma-separated hex pubkeys allowed to call `/admin/*` |

The **operational signer nsecs** live only on Box C at
`/opt/deepmarks-bunker/nsecs/{brand,personal}.nsec`, chmod 400 owned by the
`bunker` system user — not in any `.env` file, not on Box A. See
[bunker.md](bunker.md) for placement + rotation.

All other secrets live in `/opt/deepmarks-repo/deploy/box-{a,c}/.env`
on their respective boxes (chmod 600). None are ever committed — see
the `.gitignore` in the repo root.
