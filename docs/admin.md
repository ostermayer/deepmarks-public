# Admin management

Operational docs for running Deepmarks as its operator. Covers the
admin-only HTTP endpoints, the CLI wrapper, auth, and the recovery
playbooks that use them.

## Auth model — NIP-98

Admin endpoints use [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md)
(HTTP Auth). The flow:

1. The caller constructs a **kind:27235** Nostr event:
   - `tags: [["u", "<full URL>"], ["method", "POST"]]`
   - `created_at` in the last ~60 seconds (stale events are rejected)
   - empty `content`
2. Signs with the admin nsec.
3. Sends it as `Authorization: Nostr <base64(signed event)>`.

The server verifies:
- signature against the event's own pubkey
- URL + method match the request
- timestamp is fresh
- the pubkey is in `ADMIN_PUBKEYS` (comma-separated list)

The signed event is **never published to a relay** — it's a one-shot
bearer credential bound to the specific URL + method + timestamp. Replay
is prevented by the freshness window.

Why NIP-98 over a bearer token:
- token leaks in logs can't be replayed after the freshness window
- no secret to rotate — rotate the nsec if it's ever compromised
- reuses signer infrastructure we already have

## Getting set up

Role separation is the recommended pattern: **don't use your personal
Nostr key for admin.** Generate a dedicated `deepmarks-admin` nsec, save
it to a password manager, and add only its pubkey to `ADMIN_PUBKEYS`.

1. Generate an nsec (any tool — nostr-tools, Alby's create-account, etc.)
2. Save it somewhere safe (1Password / Bitwarden / etc.) and to
   `deepmarks-admin-nsec.txt` in the repo root — the `.gitignore`
   `*nsec*` rule keeps it out of commits.
3. Convert nsec → pubkey (hex):
   ```bash
   ./deploy/admin.mjs status <your-npub>   # hex shown in the output URL
   ```
4. Append to `/opt/deepmarks-repo/deploy/box-a/.env`:
   ```
   ADMIN_PUBKEYS=<hex-pubkey>
   ```
5. Redeploy: `/opt/deepmarks-repo/deploy/deploy.sh a`

Multiple admins: comma-separate their pubkeys in `ADMIN_PUBKEYS`.

## Admin CLI

[`deploy/admin.mjs`](../deploy/admin.mjs) is a small Node script that
reads the admin nsec, signs the NIP-98 credential locally, and issues
the HTTP call. Run from your laptop — **the nsec never touches the
server**.

### Nsec resolution order

1. `$DEEPMARKS_ADMIN_NSEC` (literal nsec1… or 64-char hex)
2. `$DEEPMARKS_ADMIN_NSEC_FILE` (path to a file holding the nsec)
3. `./deepmarks-admin-nsec.txt` in the repo root (fallback)

### Commands

```bash
./deploy/admin.mjs members                      # list current lifetime members
./deploy/admin.mjs reconcile                    # rebuild from BTCPay (see below)
./deploy/admin.mjs stamp <npub|hex> [paidAt]    # manually grant lifetime
./deploy/admin.mjs status <npub|hex>            # public status check (no auth)
```

All commands print `HTTP <code>` + the JSON response and exit with the
response's success state (0 on 2xx, 1 otherwise) so you can wire them
into shell scripts.

### API base override

Defaults to `https://api.deepmarks.org`. Override for local dev:

```bash
DEEPMARKS_API_BASE=http://localhost:4000 ./deploy/admin.mjs members
```

## Endpoints reference

### `GET /admin/lifetime/members`

Returns the current lifetime-member list. Used for audit + sanity
checks. Output is `{ count, members: [{ pubkey, paidAt }] }` sorted by
`paidAt` ascending.

### `POST /admin/lifetime/reconcile`

Pages through every **Settled** invoice in our BTCPay store, filters
for `metadata.deepmarksProduct === "lifetime"`, and stamps any pubkey
Redis doesn't already know about. Uses the invoice's `expirationTime`
as `paidAt` so retroactive stamps show the real payment date.

Idempotent — safe to run repeatedly. Response:

```json
{ "scanned": 91, "stamped": 1, "skipped": 90 }
```

(`skipped` = invoices that were Settled but not lifetime purchases —
normal if your BTCPay store also handles other products.)

### `POST /admin/lifetime/stamp`

Grant lifetime to an arbitrary pubkey. Body:

```json
{ "pubkey": "<hex>", "paidAt": 1700000000 }
```

`paidAt` is optional (defaults to now). Also publishes the
[NIP-32 lifetime label](nostr.md#kind-1985--lifetime-membership-labels)
to relays so the durability-ledger stays in sync.

### `GET /account/lifetime/status?pubkey=<hex>` (no auth)

Public check for any pubkey. Useful for debugging ("did the webhook
fire?") and is what the frontend sidebar badge uses. Not under
`/admin/*` because the answer is already public via the NIP-32 label.

## Playbooks

### "A user paid but didn't get their lifetime pennant"

Most common cause: the BTCPay webhook delivery failed (network blip,
container restart during delivery, etc.). BTCPay keeps its own retry
queue but if that too gave up, reconcile recovers it:

```bash
./deploy/admin.mjs reconcile
./deploy/admin.mjs status <their-npub>  # confirm
```

If BTCPay has no record of their invoice at all, they weren't charged —
they may have closed the tab before the Lightning invoice settled on
their wallet's side.

### "Redis was wiped / box was rebuilt"

Same path. Reconcile pulls every lifetime payment from BTCPay and
re-stamps them. Nightly S3 snapshots (`s3://deepmarks/redis/dump-*.rdb`)
are the second-order safety net if BTCPay itself is unreachable.

The boot-time [NIP-32 label sync](nostr.md#kind-1985--lifetime-membership-labels)
also rehydrates from relays automatically — no admin action needed for
that path.

### "Comp a friend / promo grant"

```bash
./deploy/admin.mjs stamp <their-npub>
```

The server publishes the NIP-32 label the same way it would for a
settlement, so the record is just as durable as a paid upgrade.

### "Audit who's currently a lifetime member"

```bash
./deploy/admin.mjs members > members-$(date +%Y-%m-%d).json
```

## Other admin endpoints

These exist in the codebase but are outside the lifetime-membership
scope covered above:

- `GET /admin/reports/pending` — list pending content-moderation reports
- `POST /admin/reports/:id/action` — take a takedown action
- `POST /admin/appeals/:token/grant` — grant a moderation appeal (501
  stub; the admin dashboard's backend work lives in a separate service
  at `admin.deepmarks.org` per the architecture spec)

Same `ADMIN_PUBKEYS` + NIP-98 auth model applies to all of them.

## Threat model

- **ADMIN_PUBKEYS list is public-safe.** The pubkeys themselves leak no
  authority — only the holder of the matching nsec can sign a valid
  credential.
- **Admin + brand are the same pubkey in practice.** A single
  `deepmarks-admin-nsec.txt` on the operator laptop serves two roles:
  locally it signs NIP-98 credentials for `/admin/*` endpoints; a copy
  on Box C (inside the bunker vault) signs zap receipts + lifetime
  labels + kind:39701 seeder events. Rotating means regenerating the
  nsec, updating `ADMIN_PUBKEYS` on Box A, replacing
  `/opt/deepmarks-bunker/nsecs/brand.nsec` on Box C, and redeploying
  both.
- **Compromised admin nsec**: attacker can comp lifetime memberships,
  read the member list, take moderation actions, AND (because it's the
  same key) forge zap receipts and lifetime labels after posting them
  to relays. They still cannot sign kind:1 notes, change profile
  metadata, or publish deletions — the bunker's permission allowlist
  rejects anything outside {9735, 1985, 39701}.
- **Compromised Box A**: attacker can request signatures from the
  bunker on the narrow allowlist, but cannot **exfiltrate any nsec**.
  Nsecs never exist in Box A's memory or filesystem. See
  [bunker.md](bunker.md#threat-model) for the full capability matrix.
- **Compromised Box C**: attacker gets both nsecs and can sign
  arbitrary events. Rotate by generating new nsecs, replacing the
  files on Box C, and updating the `nostrPubkey` envs on Box A. The
  first hint a user will have is a pubkey change on LNURL metadata.
- **Stolen laptop with the admin nsec file**: equivalent to admin nsec
  compromise above. Keep `deepmarks-admin-nsec.txt` in a location
  requiring full-disk-encryption unlock, not in a synced folder that
  leaks across devices.

See [nostr.md](nostr.md) for the broader key-hygiene rules and
[bunker.md](bunker.md) for the bunker's permission model.
