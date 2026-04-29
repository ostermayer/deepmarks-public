# Nostr on Deepmarks

How Deepmarks uses the Nostr protocol for every piece of user data,
what NIPs we implement, and the citizenship rules we follow so we
don't pollute the network.

## TL;DR

- Every user-authored bookmark is a signed Nostr event. The relay is
  the source of truth; our database is a cache / index.
- We follow existing NIPs for everything we publish. No custom kinds.
- We never publish kind 1 text notes on users' behalf — the social
  feed is not our data store.
- Users bring their own signer. We never ask for an nsec on the web.
- NIP-65 outbox model: when we publish on behalf of a user, we publish
  to *their* declared write-relays, not ours.

## Event kinds we touch

| Kind | NIP | Direction | Purpose |
|---:|---|---|---|
| 0 | [01](https://github.com/nostr-protocol/nips/blob/master/01.md) | read + publish (user-initiated) | profile metadata for feed-row attribution + user profile page; the profile-picture editor on `/app/settings` re-publishes kind:0 with the merged picture URL |
| 1 | [01](https://github.com/nostr-protocol/nips/blob/master/01.md) | — | we never publish kind 1; see citizenship rules |
| 3 | [02](https://github.com/nostr-protocol/nips/blob/master/02.md) | read (planned) | contact lists for `/app/network` feed |
| 5 | [05](https://github.com/nostr-protocol/nips/blob/master/05.md) | read | verify `nip05` identifier on user profiles |
| 7 | [25](https://github.com/nostr-protocol/nips/blob/master/25.md) | read (planned) | reactions are not displayed yet |
| 9 | [09](https://github.com/nostr-protocol/nips/blob/master/09.md) | publish | deletion requests when a user removes a bookmark |
| 9734 | [57](https://github.com/nostr-protocol/nips/blob/master/57.md) | read | zap requests — verified, stored, paired with invoices |
| 9735 | [57](https://github.com/nostr-protocol/nips/blob/master/57.md) | publish | zap receipts signed by the Deepmarks brand identity |
| 10002 | [65](https://github.com/nostr-protocol/nips/blob/master/65.md) | read | user's relay list (outbox model) |
| 10063 | [B7](https://github.com/nostr-protocol/nips/blob/master/B7.md) | publish | user's file-metadata list for archived snapshots |
| 1985 | [32](https://github.com/nostr-protocol/nips/blob/master/32.md) | publish | lifetime-membership labels (see below) |
| 24133 | [46](https://github.com/nostr-protocol/nips/blob/master/46.md) | publish/read | nostr-connect bunker messages between payment-proxy and Box C — never user-facing, relay-only |
| 27235 | [98](https://github.com/nostr-protocol/nips/blob/master/98.md) | read | HTTP auth for /api/v1 and /admin — never published |
| 23194 | [47](https://github.com/nostr-protocol/nips/blob/master/47.md) | publish | NWC `pay_invoice` request — extension only, signed with the per-app secret from the user's `nostr+walletconnect://` URI (NOT the user's main nsec) |
| 23195 | [47](https://github.com/nostr-protocol/nips/blob/master/47.md) | read | NWC `pay_invoice` response — extension verifies `sha256(preimage) === invoice.payment_hash` |
| 30003 | [51](https://github.com/nostr-protocol/nips/blob/master/51.md) | publish | NIP-51 categorized sets, encrypted to self via NIP-44 v2. Two `d` tags in use: `deepmarks-private` (private bookmark entries) and `deepmarks-archive-keys` (per-blob AES keys for private archives, mapped by blobHash) |
| 30078 | [78](https://github.com/nostr-protocol/nips/blob/master/78.md) | publish (planned) | cross-device user preferences |
| 39701 | [B0](https://github.com/nostr-protocol/nips/blob/master/B0.md) | publish | **public web bookmarks — our canonical shape** |

## Kind 39701 — public web bookmarks

Our headline event. A signed 39701 event *is* the bookmark — titles,
descriptions, tags, and the URL all live in the event content + tags.
Relays replicate them; any other Nostr client can read + render them.

Shape (see `payment-proxy/src/api-helpers.ts` and
`frontend/src/lib/nostr/bookmarks.ts` for the canonical builder):

```
{
  "kind": 39701,
  "tags": [
    ["d", "<url>"],              # parametric-replaceable dedup key
    ["title", "..."],
    ["description", "..."],
    ["t", "bitcoin"],            # hashtag(s)
    ["t", "privacy"],
    ["published_at", "<unix>"]
  ],
  "content": "<url>"
}
```

Because `kind:39701` is in the 30000–39999 parametric-replaceable range,
a user editing or retagging the same URL emits a new event with the
same `d` tag and it supersedes the previous one. Our feed dedup
([feed.ts](../frontend/src/lib/nostr/feed.ts)) uses `(pubkey, url)` as
the key and NIP-01's `created_at + event-id` tiebreaker.

## Kind 1985 — lifetime membership labels

Durability layer #2 for the paid lifetime tier (see
[admin.md](admin.md) and [lightning.md](lightning.md) for the full
flow). On every settlement we publish a
[NIP-32](https://github.com/nostr-protocol/nips/blob/master/32.md)
label event from the Deepmarks brand pubkey attesting that a given
member pubkey bought the lifetime tier.

```json
{
  "kind": 1985,
  "tags": [
    ["L", "org.deepmarks.tier"],
    ["l", "lifetime", "org.deepmarks.tier"],
    ["p", "<member-pubkey>"],
    ["paid_at", "<unix>"],
    ["invoice_id", "<btcpay-id>"]
  ],
  "content": "Deepmarks lifetime membership"
}
```

**Why kind 1985 and not kind 1 (a text note)?** Because label events
are machine-readable metadata and are not rendered in social timelines
(Damus/Primal/etc.). We want the attestation durable + auditable
without polluting anyone's feed. See
[citizenship rules](#citizenship-rules) below.

On startup, payment-proxy queries our own label events from relays and
re-stamps any pubkey Redis doesn't already know — so the relay ledger
is a second recovery source alongside BTCPay.

## Relay usage

### Outbox model (NIP-65)

When we publish on behalf of a user (e.g. the /api/v1/bookmarks endpoint
relays a pre-signed event), we publish to the user's **declared write
relays** from their kind:10002 event, not to our own relays. We fall
back to our default set only if we can't find a NIP-65 list.

This is the correct reading of NIP-65 — readers find events on the
author's chosen relays, so that's where the events have to live.

### What we run ourselves

- **relay.deepmarks.org** — [strfry](https://github.com/hoytech/strfry)
  with a write-policy plugin at `deploy/box-a/strfry/deepmarks.js` that
  gates by kind. Accepts from any pubkey:
  - `kind:39701` — public bookmarks (the main use case)
  - `kind:30003` — NIP-51 sets (`deepmarks-private` bookmarks +
    `deepmarks-archive-keys` archive-key sync)
  - `kind:9735` — zap receipts
  - `kind:1985` — NIP-32 lifetime labels
  - `kind:24133` — NIP-46 bunker messages (payment-proxy ↔ Box C)

  The **brand pubkey** (`7cb39c…3800`) and **personal pubkey**
  (`2944e9…e2f4`) additionally get a `TEAM_EXTENDED_KINDS` allowance
  for {0, 1, 3, 6, 7, 10002, 30023} so social-shaped activity from
  those identities flows through. All other kinds from non-team
  pubkeys are rejected. The relay is deliberately narrow — it's not
  a general-purpose public relay.
- **strfry internal** (`ws://strfry:7777` from inside the docker
  network, `ws://10.0.0.2:7777` from the VPC) — used by the payment-
  proxy's internal workers, the `/archive/lifetime` + webhook-settlement
  paths, AND the bunker NIP-46 channel. Same backing data as the public
  relay at `wss://relay.deepmarks.org`.

### What we don't do

- We don't force users to publish to our relay. The app reads
  NIP-65 lists and publishes accordingly.
- We don't rewrite events before publishing. If your client signs an
  event, the bytes we relay are the bytes you signed. (We do validate
  schema + reject abuse per the strfry write-policy plugin, but that's
  reject-or-accept, never edit.)

## Identities we hold

- **Deepmarks brand** (`npub10jeecm…`, LNURL `zap@deepmarks.org`): signs
  NIP-57 zap receipts for the 10% site-share of every public-bookmark
  zap, NIP-32 lifetime labels, and `kind:39701` events published by the
  Pinboard seeder. Advertised as `nostrPubkey` in the `zap@` LNURL
  metadata. The **nsec lives on Box C inside the bunker**, never on
  Box A.
- **Personal (operator)** (`npub199z…`, LNURL `dan@deepmarks.org`): signs
  NIP-57 zap receipts for the operator's Damus profile. Advertised as
  `nostrPubkey` in the `dan@` LNURL metadata. Nsec also lives on Box C.
- **Deepmarks admin** (same pubkey as brand; nsec on operator laptop):
  signs NIP-98 credentials for `/admin/*` endpoints. Never publishes
  events to relays and **never** travels to the bunker — the admin
  flow is always operator-initiated from their laptop. See
  [admin.md](admin.md).
- **User nsecs**: *never* touch our servers. NIP-07 extensions (Alby,
  nos2x, Flamingo) or a local nsec entered into the browser do all
  signing in-browser. The payment-proxy only ever receives already-
  signed events.

## How the server signs without holding keys

Payment-proxy speaks NIP-46 (nostr-connect) to Box C's bunker, which
holds the brand and personal nsecs. Every time payment-proxy needs to
publish a zap receipt, lifetime label, or seeded bookmark, it:

1. Builds the event *template* (kind, tags, content, created_at).
2. Encrypts a `{id, method: "sign_event", params: [template]}` envelope
   with NIP-44 using its own ephemeral client keypair +
   the identity pubkey.
3. Wraps it in a kind `24133` event and publishes to Box A's strfry
   (internal, over the VPC from Box A to Box A and VPC from Box C to
   Box A).
4. Bunker decrypts, checks the kind is in its allowlist for that
   identity (9735 + 1985 + 39701 for brand; 9735 only for personal), signs
   with the local nsec, encrypts the response, publishes back.
5. Payment-proxy pairs the response by request id, publishes the now-
   signed event to the target relays.

The nsec never leaves Box C. A Box A compromise gets the attacker
signatures on the allowlist only — not notes, not profile edits, not
deletions, not keys. See [bunker.md](bunker.md) for the full threat
model + permission matrix.

## Private data — NIP-44 v2

Private bookmarks (kind:30003 NIP-51 sets) are encrypted with
[NIP-44 v2](https://github.com/nostr-protocol/nips/blob/master/44.md)
before they leave the browser. Our servers see ciphertext only.

The canonical copy lives on the user's relays; payment-proxy keeps an
encrypted-to-self cache in Redis (keyed by a deterministic emailHash
surrogate for historical reasons) so private-bookmark reconciliation
across devices works without re-fetching from relays. Decryption
always happens client-side. The cache is tombstoned when the user
deletes their account (`DELETE /account`).

## Citizenship rules

Rules we follow so Nostr stays useful for everyone, not just us.

**1. Don't invent custom kinds when a NIP exists.** Labels get kind
1985. Bookmarks use 39701 (NIP-B0). Zap receipts are 9735. We
deliberately did not mint a "deepmarks-bookmark" kind — that would
fragment the ecosystem.

**2. Don't publish kind:1 on users' behalf.** Social timelines are
where people talk; filling them with "just bookmarked X" or "Y became a
lifetime member" is spam. Our attestations live in kind 1985 exactly
because it won't render in Damus/Primal/Amethyst/etc.

**3. Don't publish from user pubkeys.** We never sign events as
the user — only the user's signer signs user events. Every bookmark
they "publish via deepmarks.org" is a bytes-identical pre-signed event
we relay.

**4. Honor NIP-65.** When we publish or query on behalf of a user, we
use their declared relays, not ours. Reading from arbitrary public
relays when a specific relay is known to have the data is wasteful.

**5. Don't re-publish events we didn't author.** We index what we read
but never re-publish (doing so would double-forward events and waste
relay bandwidth). Exceptions: NIP-65 republication when a user adds a
new relay in-app — a deliberate "copy my history to this new relay"
action with a UI confirmation.

**6. Delete on request.** Kind:9 deletion events are respected by our
indexer. Once relayed, we can't un-relay from every relay in the
network, but our own data is forgotten and the event's absence on
user-chosen relays is how deletion propagates.

**7. No tracking disguised as events.** We don't publish "heartbeat" or
"user-online" events. The network's purpose is communication, not
analytics.

**8. Accept diversity of clients.** Any Nostr client (Damus, Primal,
Amethyst, Coracle, ...) can read the bookmarks users publish via
Deepmarks — the reverse is also true: bookmarks created by other
clients that use kind:39701 appear in our feed unmodified. There's no
"Deepmarks-only" namespace.

## Implementation locations

| Concern | Code |
|---|---|
| Bookmark builder + parser | [`frontend/src/lib/nostr/bookmarks.ts`](../frontend/src/lib/nostr/bookmarks.ts) |
| Live feed subscription + dedup | [`frontend/src/lib/nostr/feed.ts`](../frontend/src/lib/nostr/feed.ts) |
| Private-set NIP-51 + NIP-44 | [`frontend/src/lib/nostr/private-bookmarks.ts`](../frontend/src/lib/nostr/private-bookmarks.ts) |
| NIP-07 / nsec / NIP-46 signer abstraction (frontend) | [`frontend/src/lib/nostr/signers/`](../frontend/src/lib/nostr/signers/) |
| NIP-98 builder | [`frontend/src/lib/api/client.ts`](../frontend/src/lib/api/client.ts) (`buildNip98AuthHeader`) |
| Zap request validation + receipt template | [`payment-proxy/src/nostr.ts`](../payment-proxy/src/nostr.ts) |
| NIP-32 lifetime label template + publish | [`payment-proxy/src/nostr.ts`](../payment-proxy/src/nostr.ts) |
| NIP-46 bunker client (payment-proxy → Box C) | [`payment-proxy/src/signer.ts`](../payment-proxy/src/signer.ts) |
| NIP-46 bunker server (Box C signing service) | [`bunker/src/handler.ts`](../bunker/src/handler.ts) + [`bunker/src/vault.ts`](../bunker/src/vault.ts) |
| Bunker permission allowlist | [`bunker/src/permissions.ts`](../bunker/src/permissions.ts) |
| NIP-98 verification | [`payment-proxy/src/auth.ts`](../payment-proxy/src/auth.ts) (`verifyNip98`) |
| Strfry write-policy plugin | [`deploy/box-a/strfry/deepmarks.js`](../deploy/box-a/strfry/deepmarks.js) |
