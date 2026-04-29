# Lightning on Deepmarks

Bitcoin is the only money we take. Every paid flow — archive-per-page,
zaps, the lifetime upgrade — is a Lightning payment. Nothing custodial:
we never hold a user's sats beyond the split we're owed.

## Moving parts

| Component | Role |
|---|---|
| **Voltage node** | Our own LND instance. Receives archive-per-page and zap payments directly. |
| **BTCPay Server** (Voltage-hosted) | Hosted checkout for the user-initiated lifetime upgrade. Talks to the same LND node over gRPC. |
| **`payment-proxy`** | Fastify service on Box A. Builds invoices, verifies settlement, signs zap receipts, serves the LNURL-pay endpoint. |
| **`archive-worker`** | Box B. Consumes the archive queue once a payment settles. Never sees Lightning directly. |

See [architecture.md](architecture.md) for the host-level layout.

## Voltage — direct path

For archive purchases and zaps, the payment-proxy talks directly to
Voltage's gRPC endpoint (port **10009**, not the REST 8080) using the
[`lightning`](https://www.npmjs.com/package/lightning) npm package.

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

### Invoice-settlement worker

`subscribeToInvoices` in payment-proxy fans out settled invoices to
two handlers:

1. **Zap receipts** — if the payment hash matches a pending zap, build
   the NIP-57 receipt and publish to the zap request's declared relays.
2. **Archive purchases** — if it matches a pending archive, push the job
   to `ARCHIVE_QUEUE` in Redis; the archive-worker picks it up.

The `SubscriptionCircuitBreaker` reconnects on transient Voltage
outages without a hot-loop storm.

## LNURL-pay — two hosted addresses

We host two Lightning addresses on `deepmarks.org`, each backed by a
distinct Nostr identity:

| Address | `nostrPubkey` | Purpose |
|---|---|---|
| `zap@deepmarks.org` | brand (`npub10jeec…`) | Site tipjar — receives the 10% Deepmarks share of every public-bookmark zap split (see below) |
| `dan@deepmarks.org` | personal (`npub199z…`) | Operator's Damus profile — receives personal zaps when someone taps ⚡ on a note |

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
4. Wallet calls the callback with `?amount=<msat>&nostr=<zap-request>`.
5. Payment-proxy verifies the NIP-57 zap request, creates an invoice
   with `description_hash = sha256(<exact zap request JSON bytes>)`,
   and returns the BOLT-11 string.
6. On invoice settlement, the payment-proxy picks the matching signer
   by comparing the zap request's `p` tag against the identity
   registry, sends a NIP-46 `sign_event` request to the Box C bunker,
   and publishes the signed kind:9735 receipt to the relays specified
   in the zap request.

The `description_hash` must be the sha256 of the *exact bytes* the
client sent — no re-serialization. This is a CLAUDE.md MUST-rule; we
have tests locking it down (`payment-proxy/src/nostr.test.ts`). Signing
happens on the bunker, not on Box A — see [nostr.md](nostr.md#how-the-server-signs-without-holding-keys)
and [bunker.md](bunker.md).

## Zap splits on public bookmarks

When a user taps "zap this bookmark" with a sats amount:

- **80%** → the curator who saved the bookmark (their `lud16`, looked up
  via their kind:0 profile)
- **10%** → the site operator whose page was bookmarked (if a
  `lightning:` URL can be sniffed from the page metadata)
- **10%** → Deepmarks

The wallet pays **three separate invoices**. Nothing is custodial. If
the operator's Lightning address isn't detectable, that share
merges into Deepmarks' 10% (never the curator's 80%, by design).

Split math + receipt pairing are in
[`frontend/src/lib/nostr/zap.ts`](../frontend/src/lib/nostr/zap.ts)
with round-trip tests in `zap.test.ts`.

## Archive purchases (pay-as-you-go)

500 sats per page. The flow:

1. Frontend (or browser extension) calls `POST /archive/purchase` with
   `{ url, tier, pubkey }`. For lifetime members the equivalent is
   `POST /archive/lifetime` (no invoice, jumps straight to enqueue).
2. Payment-proxy creates a BOLT-11 invoice via Voltage and persists a
   pending `PurchaseRecord` keyed by payment hash.
3. Frontend pays the invoice. Two wallet paths:
   - **WebLN** (browser-bridged wallet): `window.webln.sendPayment(invoice)`
   - **NWC** (NIP-47 Nostr Wallet Connect): the browser extension lets
     the user paste a `nostr+walletconnect://` URI from their wallet
     (Alby Hub, Mutiny, Coinos, ZBD…) in Settings; the InvoiceCard then
     surfaces a "Pay with connected wallet" one-tap button. Under the
     hood we sign a kind:23194 with the per-app secret from the URI,
     publish to the wallet's relay, and verify the response by checking
     `sha256(preimage) === invoice.payment_hash`.
4. On settlement the invoice-subscription worker moves the record to
   `enqueued` and pushes an `ArchiveJob` to `dm:archive:queue` (Redis).
5. Archive-worker pops via BLMOVE into a per-worker
   `dm:archive:processing:<wid>` list (so a crash mid-render doesn't
   drop the job — `recoverOrphans` on next startup re-queues anything
   left), renders with headless Playwright + SingleFile, mirrors to
   Blossom, and callbacks `POST /archive/callback` with the Blossom hash.

Private archives are AES-256-GCM encrypted in the archive-worker before
Blossom upload using a key the browser generates and ships once with
the purchase. The worker zeroes the plaintext key after encryption;
the browser stashes it locally (chrome.storage.local) AND publishes a
NIP-51 kind:30003 set with `d="deepmarks-archive-keys"` so the same
account can decrypt the snapshot from any signed-in device. Public
archives are plaintext and federate freely.

## Lifetime tier — BTCPay Server

The one flow that doesn't use direct Voltage. BTCPay handles the
hosted checkout page (QR + payment-method fallback + expiry UX +
receipt) so we don't hand-build it.

### Why split

- Archive purchases + zaps are **server-initiated** (programmatic
  invoice creation for a specific job). No UI, so no reason to ship a
  BTCPay redirect.
- Lifetime upgrades are **user-initiated**. The user clicks "upgrade",
  sees a price, wants an obvious "pay now" button. BTCPay's hosted
  checkout is strictly better than re-implementing that UI.

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
6. BTCPay's auto-redirect sends the user to `/app/upgrade?done=1` and
   the frontend polls status until the pennant lights up.

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

### Free archives for members

Lifetime members bypass the invoice entirely:

- `POST /archive/lifetime` (NIP-98, lifetime-gated) → directly enqueues
  an `ArchiveJob` with a synthetic `lifetime:<hex>` payment hash.
- No invoice, no WebLN round-trip, no sats transferred.
- Archive-worker doesn't know the difference — it just sees a queued
  job.

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
| `VOLTAGE_REST_URL` | Box A | Host:port for gRPC, e.g. `simpleworld.m.voltageapp.io:10009` |
| `VOLTAGE_INVOICE_MACAROON` | Box A | hex-encoded, invoice-only |
| `VOLTAGE_TLS_CERT` | Box A | optional; Voltage uses public CAs |
| `BUNKER_CLIENT_NSEC` | Box A | payment-proxy's ephemeral key to the bunker; **not** the brand or personal nsec |
| `BUNKER_RELAY_URL` | Box A | `ws://strfry:7777` (internal docker network) |
| `BUNKER_BRAND_PUBKEY` | Box A | brand identity pubkey — advertised as `nostrPubkey` for `zap@` |
| `BUNKER_PERSONAL_PUBKEY` | Box A | personal identity pubkey — advertised as `nostrPubkey` for `dan@` |
| `BUNKER_CLIENT_PUBKEY` | Box C | Allowlist — the single client pubkey the bunker will honor sign requests from |
| `BTCPAY_URL` | Box A | `https://btcpay0.voltageapp.io` |
| `BTCPAY_STORE_ID` | Box A | the store pointing at our Voltage node |
| `BTCPAY_API_KEY` | Box A | Greenfield key, scoped to `cancreateinvoice` + `canviewinvoices` |
| `BTCPAY_WEBHOOK_SECRET` | Box A | used to verify webhook deliveries |
| `ADMIN_PUBKEYS` | Box A | comma-separated hex pubkeys allowed to call `/admin/*` |

The **brand and personal nsecs** live only on Box C at
`/opt/deepmarks-bunker/nsecs/{brand,personal}.nsec`, chmod 400 owned by the
`bunker` system user — not in any `.env` file, not on Box A. See
[bunker.md](bunker.md) for placement + rotation.

All other secrets live in `/opt/deepmarks-repo/deploy/box-{a,c}/.env`
on their respective boxes (chmod 600). None are ever committed — see
the `.gitignore` in the repo root.
