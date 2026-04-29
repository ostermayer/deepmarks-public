# Deepmarks Payment Proxy

Box A payment service for Deepmarks. Two jobs:

1. **Archive purchases** — issue 500-sat Lightning invoices for the paid archive tier, watch for settlement, enqueue jobs for Box B.
2. **`zap@deepmarks.org`** — host the LNURL-pay endpoint ourselves, generate zap invoices with proper `description_hash` commitment, and publish NIP-57 `kind:9735` zap receipts signed with the Deepmarks Nostr key.

Both flows terminate at the Voltage-hosted Lightning node. We use the `invoice`-only macaroon — if this service is compromised, the attacker cannot move funds.

## Module layout

```
src/
├── index.ts             Fastify bootstrap, route handlers, worker wiring
├── voltage.ts           Lightning invoice creation (optional in dev)
├── queue.ts             PurchaseStore, ZapStore, createRedis()
├── nostr.ts             DEEPMARKS_NSEC load, zap-request validation, kind:9735 construction
├── lnurl.ts             LUD-06 metadata + description-hash helper
├── account.ts           AccountStore (email-linked sessions, lifetime-tier marker)
├── auth.ts              Session JWT + NIP-98 HTTP auth
├── email.ts             Resend wrapper (stdout logger in dev)
├── blocklist.ts         Moderation stores (hashes, URLs, event ids, suspensions)
├── reports.ts           Report intake + triage queue
├── search.ts            Meilisearch client + BookmarkIndexer
├── blossom-mirror.ts    BUD-04 mirror fanout (mirror-retry worker lives here)
├── api-keys.ts          /api/v1 key store (hash-only Redis)
├── api-helpers.ts       Pure Nostr helpers for /api/v1 (publish + query pool)
├── archive-purchase.ts  Shared invoice path for /archive/purchase + /api/v1/archives
└── workers/
    ├── zap-listener.ts         kind:9735 ingest → Meilisearch zap_total
    ├── save-count-tracker.ts   kind:39701 save-count aggregation
    └── profile-resolver.ts     kind:0 profile name lookup for search ranking
```

Every module has `*.test.ts` tests except `email.ts`, `queue.ts`, and `blossom-mirror.ts` (stubs for services that are exercised end-to-end against Redis + Blossom in integration — unit tests against those depend on real external state).

## Endpoints

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| `POST` | `/archive/purchase` | Create invoice for archive tier | none |
| `GET`  | `/archive/status/:hash` | Poll settlement state | none |
| `GET`  | `/.well-known/lnurlp/zap` | LNURL-pay metadata (LUD-06 + NIP-57) | none |
| `GET`  | `/lnurlp/zap/callback` | Invoice issuance (zap-aware) | none |
| `POST` | `/account/link-email` | Link email to account (sends code) | NIP-98 |
| `POST` | `/account/verify-link` | Confirm email code, finalize link | none (code is the factor) |
| `POST` | `/auth/email/request` | Start email sign-in, send code | none |
| `POST` | `/auth/email/verify` | Confirm code, issue session token | none |
| `GET`  | `/account/me` | Session introspection | Bearer JWT |
| `POST` | `/account/rotate-pubkey` | Rotate nsec on existing email link | NIP-98 + session |
| `GET`  | `/health` | Liveness | none |
| `POST` | `/api/v1/keys` | Create API key (plaintext returned once) | NIP-98 + lifetime-tier gate |
| `GET`  | `/api/v1/keys` | List my API keys (metadata only) | NIP-98 |
| `DELETE` | `/api/v1/keys/:id` | Revoke an API key | NIP-98 |
| `GET`  | `/api/v1/bookmarks` | List my bookmarks (filters: `tag`, `archived`, `limit`) | Bearer `dmk_live_…` |
| `POST` | `/api/v1/bookmarks` | Publish a pre-signed `kind:39701` | Bearer `dmk_live_…` |
| `DELETE` | `/api/v1/bookmarks/:eventId` | Publish a pre-signed `kind:5` | Bearer `dmk_live_…` |
| `POST` | `/api/v1/archives` | Start archive purchase (invoice) | Bearer `dmk_live_…` |
| `GET`  | `/api/v1/archives/:jobId` | Poll archive status | Bearer `dmk_live_…` |

See [`docs/api-v1.md`](../docs/api-v1.md) for the complete API reference with curl examples, auth flows, error codes, and pre-signed event requirements.

## What hosting LNURL in-house means

When someone zaps `zap@deepmarks.org` on any Nostr client:

1. Client resolves the address → `GET https://deepmarks.org/.well-known/lnurlp/zap` → hits **this service**
2. Client sends a kind:9734 zap request → `GET /lnurlp/zap/callback?amount=1000&nostr=<encoded request>` → hits **this service**
3. This service validates the zap request per NIP-57 Appendix D, computes `description_hash = SHA-256(raw zap request JSON)`, generates a BOLT-11 via Voltage
4. User's wallet pays. Sats land in the Voltage node.
5. Voltage's invoice-subscription stream tells us the invoice settled.
6. This service builds a kind:9735 zap receipt, signs it with `DEEPMARKS_NSEC`, publishes to the relays specified in the zap request.

Every piece of this except the node itself runs in-house. The service owns:

- The LNURL endpoint
- The description-hash commitment
- The zap receipt publishing

Voltage owns:

- Invoice generation (we call LND REST)
- Channel liquidity and uptime
- The money

## Two macaroon-adjacent secrets, two different risk profiles

| Secret | Lives on | If leaked |
| --- | --- | --- |
| `VOLTAGE_INVOICE_MACAROON` | Box A | Attacker can create dud invoices. Cannot move funds, close channels, or export keys. |
| `DEEPMARKS_NSEC` | Box A | Attacker can sign fake zap receipts and impersonate deepmarks on Nostr. Cannot move funds. |

Both live in `/opt/deepmarks/.env`, `chmod 600`, owned by the container user.

## Archive purchase flow

```
User clicks "archive forever"
  ↓
Frontend → POST /archive/purchase {url, userPubkey}
  ↓
proxy → Voltage.createInvoice(500 sats, description)
  ↓
Frontend renders BOLT-11 as QR
  ↓
User pays from any wallet
  ↓
Voltage settles → invoice_updated event on proxy's subscription
  ↓
proxy → RPUSH dm:archive-jobs {url, eventId, userPubkey, hash, paidAt}
  ↓
Box B BLPOPs job, renders page, uploads to Blossom, updates event
```

### Example

```bash
curl -X POST https://deepmarks.org/archive/purchase \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://example.com/article",
    "userPubkey": "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2"
  }'

# → { "invoice": "lnbc5u1p...", "paymentHash": "...", "amountSats": 500, "expiresInSeconds": 3600 }

curl https://deepmarks.org/archive/status/<paymentHash>
# → { "status": "enqueued", "paidAt": 1745318400, ... }
```

## Zap flow

```
Someone zaps zap@deepmarks.org
  ↓
Their client → GET /.well-known/lnurlp/zap
  ↓                                   → { callback, allowsNostr: true, nostrPubkey, ... }
Their client signs a kind:9734 zap request
  ↓
  → GET /lnurlp/zap/callback?amount=21000&nostr=<encoded>
  ↓
proxy validates, hashes raw JSON → descHash
  ↓
proxy → Voltage.createInvoice(mtokens: 21000, description_hash: descHash)
  ↓
  → { pr: "lnbc21n1p...", routes: [] }
Their wallet pays the BOLT-11
  ↓
Voltage settles → invoice_updated
  ↓
proxy builds kind:9735 { bolt11, description: rawZapRequest, p, e, P, ... }
  ↓
proxy signs with DEEPMARKS_NSEC → publishes to relays from zap request
  ↓
Nostr clients see the zap receipt, display the zap on the zapped note/profile
```

### Manual test

```bash
curl https://deepmarks.org/.well-known/lnurlp/zap | jq
# {
#   "callback": "https://deepmarks.org/lnurlp/zap/callback",
#   "minSendable": 1000,
#   "maxSendable": 100000000000,
#   "metadata": "[[\"text/plain\",\"Zap Deepmarks — bookmarks for the open web\"],[\"text/identifier\",\"zap@deepmarks.org\"]]",
#   "tag": "payRequest",
#   "allowsNostr": true,
#   "nostrPubkey": "<deepmarks hex pubkey>",
#   "commentAllowed": 280
# }

# Plain LUD-06 invoice (no zap request)
curl 'https://deepmarks.org/lnurlp/zap/callback?amount=1000'
# { "pr": "lnbc1n...", "routes": [] }
```

## Email-linked session auth (Flow K)

Two-tier auth model: **email = session identity**, **nsec = Nostr authority**. Email sign-in lets users read their own account (including private bookmarks) from any device. Only a connected signer can write. We never hold the user's nsec — we only hold ciphertext we cannot decrypt.

### Linking email to an existing account

```
1. User is signed in with their nsec (browser-side).
2. Client generates:
     - random 256-bit view key K
     - random 16-byte salt
     - wrap key = Argon2id(passphrase, salt, memory=64MiB, iter=3, p=4)
     - ciphertext = AES-256-GCM(wrap_key, K)
3. Client POSTs /account/link-email with the ciphertext + salt,
   signed with a NIP-98 auth event (proves nsec possession).
4. Server stores the ciphertext and sends a 6-digit code to the email.
5. Client POSTs /account/verify-link with the code.
6. Server finalizes the account row, issues a 'full' session JWT.
```

### Email sign-in

```
1. User enters email → POST /auth/email/request
   Server always returns 200 (no account enumeration).
2. User enters code + passphrase → POST /auth/email/verify
   Server returns: session token + encrypted view key + salt + KDF params
3. Client derives wrap key from passphrase (Argon2id, same salt),
   decrypts view key into browser memory.
4. Session is now 'email' tier — can decrypt private bookmarks,
   cannot sign. User sees "connect signer" prompts on any write
   action (save, zap, post).
5. Connecting a signer silently upgrades to 'full' tier on the
   client side. No server round-trip needed.
```

### What we hold

- Salted SHA-256 of email (`email_hash`)
- Pubkey the email is bound to
- Encrypted view key (ciphertext, base64)
- Salt + KDF params (public; needed to re-derive wrap key)
- Session JWT audit log

### What we never hold

- Plaintext email
- Passphrase
- Wrap key derived from passphrase
- View key plaintext
- User's nsec
- Plaintext of any private bookmark

### Key rotation

If the user rotates their nsec (voluntarily — they still have the old one in memory or they're connecting a new signer), `POST /account/rotate-pubkey` updates the email ↔ pubkey mapping. Requires NIP-98 auth from the NEW pubkey + the current session token as a second factor so a random attacker can't hijack an email by providing a fresh NIP-98 from a made-up key.

## Architecture

```
┌─────────────────────────────┐    ┌─────────────────────────────┐
│  Browser / Nostr client     │    │ Any zapper's Nostr client   │
└─────┬──────────────────┬────┘    └──────────┬──────────────────┘
      │ POST             │                    │ GET /.well-known/
      │ /archive/purchase│                    │   lnurlp/zap
      │                  │                    │ GET /lnurlp/zap/callback
      ▼                  ▼                    ▼
┌────────────────────────────────────────────────────┐
│           payment-proxy (this service)             │
│  ─ Fastify HTTP routes                             │
│  ─ Voltage REST client (invoice-only macaroon)     │
│  ─ Zap-request validator (NIP-57 Appendix D)       │
│  ─ kind:9735 receipt signer & publisher            │
│  ─ Long-lived subscribeToInvoices stream           │
└──────┬────────────────────────────────┬────────────┘
       │ createInvoice /                │ RPUSH on archive settle
       │ invoice_updated                │ DEL zap key on zap settle
       ▼                                ▼
┌────────────────┐              ┌─────────────┐
│    Voltage     │              │    Redis    │───▶ Box B (archive worker)
│   (LND REST)   │              └─────────────┘
└────────────────┘                     │
                                       │ Published zap receipts (9735)
                                       ▼
                              ┌──────────────────┐
                              │  Nostr relays    │
                              │  (from zap req)  │
                              └──────────────────┘
```

## Edge cases handled

- **Replay of invoice_updated events.** The zap-receipt handler uses `zaps.consume(hash)` which atomically deletes the Redis key, so duplicate events can't double-publish receipts. The archive-purchase handler uses a status state machine that no-ops if already `enqueued`.
- **Invoices on the node that aren't ours** (e.g. manual test invoices from the Voltage dashboard). Ignored — if the payment hash isn't in either Redis store, we do nothing.
- **Zap request with invalid signature.** Rejected with HTTP 400 before any invoice is created.
- **Zap request missing `relays` tag.** Rejected — without relays we'd have nowhere to publish the receipt.
- **Zap request `amount` tag mismatch with callback `amount` param.** Rejected.
- **Relay publish failures.** Best-effort with 5s timeout. Publishing to 3 of 5 relays still counts as success; only fails if every single relay in the list is unreachable.

## Setup

### Local dev

```bash
cp .env.example .env
# Fill in VOLTAGE_REST_URL, VOLTAGE_INVOICE_MACAROON, DEEPMARKS_NSEC
# Generate a test nsec: npx nostr-tools genprivkey (or use an existing one)

npm install
npm run dev
```

### Production (Box A)

```bash
docker build -t deepmarks-payment-proxy .
# Runs as part of Box A's compose.yml with Caddy in front for TLS.
```

### Caddy config on Box A

```caddy
deepmarks.org {
  # ...other rules for frontend...

  handle /.well-known/lnurlp/* {
    reverse_proxy payment-proxy:4000
  }

  handle /lnurlp/* {
    reverse_proxy payment-proxy:4000
  }

  handle /archive/* {
    reverse_proxy payment-proxy:4000
  }
}
```

## Generating the Deepmarks nsec

One-time setup. Generate a dedicated Nostr identity for deepmarks (separate from any human operator's key):

```bash
node -e "
  const { generateSecretKey, getPublicKey, nip19 } = require('nostr-tools');
  const sk = generateSecretKey();
  console.log('nsec:', nip19.nsecEncode(sk));
  console.log('npub:', nip19.npubEncode(getPublicKey(sk)));
"
```

Put the `nsec1...` in `DEEPMARKS_NSEC`. Share the `npub1...` as your official Nostr identity (tag it in announcement posts, add it to the website).

**Back up the nsec offline.** If it's lost you lose the ability to sign as this identity and all historical zap receipts become unverifiable going forward (existing receipts remain valid; new ones would have to be signed by a different key and clients would need to notice the rotation).

## What this service does NOT do

- **Pay outgoing invoices.** The 3-way zap splits (curator + site operator + deepmarks) are paid by the user's wallet in parallel. This service only issues the deepmarks share.
- **Hold user funds.** Payments go directly to the Voltage node. Not custody.
- **Sign archive-related Nostr events.** Box B (archive worker) signs the updated kind:39701 bookmark events.
- **Manage channel liquidity.** That's Voltage's job.
