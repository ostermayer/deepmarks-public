# Admin management

Operational docs for running Deepmarks as its operator. Covers the
admin-only HTTP endpoints, the CLI wrapper, auth, and the recovery
playbooks that use them.

## Auth model — NIP-98

Admin endpoints use [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md)
(HTTP Auth). The flow:

1. The caller constructs a **kind:27235** Nostr event:
   - `tags: [["u", "<full URL>"], ["method", "POST"], ["nonce", "<random>"]]`
   - body-bearing routes also include
     `["payload", "<sha256(raw body) hex>"]`
   - `created_at` in the last ~60 seconds (stale events are rejected)
   - empty `content`
2. Signs with the admin nsec.
3. Sends it as `Authorization: Nostr <base64(signed event)>`.

The server verifies:
- signature against the event's own pubkey
- URL + method match the request
- payload hash matches when the route has a body
- timestamp is fresh
- event id has not already been used inside the replay window
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
./deploy/admin.mjs archive-rescue [--run] [--force] [--limit=N] [--pubkey=npub]
./deploy/admin.mjs archive-retry  [--run] [--force] [--limit=N] [--pubkey=npub]
```

All commands print `HTTP <code>` + the JSON response and exit with the
response's success state (0 on 2xx, 1 otherwise) so you can wire them
into shell scripts.

`archive-rescue` finds public alternatives for failed public-webpage
archives (Wayback, scholarly PDFs, URL variants, FixTweet for tweets,
LLM/search suggestions) and enqueues the best verified candidate.
`archive-retry` re-enqueues terminal public webpage/file failures from
scratch to pick up worker-side fixes (browser UA, FixTweet, etc.).
Both are **dry-run by default** — pass `--run` to actually enqueue,
`--force` to ignore the per-failure claim lock and re-process
recently-tried failures. `--limit=N` caps the batch and `--pubkey=npub`
scopes to a single owner. They call `POST /admin/archive-rescue/run`
and `POST /admin/archive-failures/retry` respectively (see below).

**Anti-loop caveat.** Both commands skip any failure whose `jobId`
starts with `rescue:` (the eligibility guard in
[`api/src/archive-retry.ts`](../api/src/archive-retry.ts) and
[`api/src/archive-rescue.ts`](../api/src/archive-rescue.ts)). A rescue
job that itself fails therefore **cannot** be recovered through
`archive-rescue` or `archive-retry` — re-enqueue it directly via
`enqueueLifetimeArchive` if you need to retry it.

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
{ "scanned": 91, "stamped": 1, "skipped": 90, "truncated": false }
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

### `GET /admin/dashboard` (NIP-98 admin)

Single JSON aggregate that the operator dashboard at
`/app/admin/dashboard` polls every 5 seconds. One round-trip gives
real-time status for:

- **metrics** — growth, revenue, and health rollups for the operator
  dashboard: relay-allowed pubkeys, lifetime members, media-archive
  add-on buyers, active short-handle claims, public bookmark events,
  encrypted private bookmark-set chunks, queue depth, box health, and
  paid-member counts by useful date ranges plus the last 12 calendar
  months.
  `dm:registered:pubkeys` is a relay/write-policy allowlist, not a
  logged-in-user count; it includes signed-in users plus followed
  curators mirrored by the server-side outbox worker. Lifetime revenue is
  estimated from the server price schedule at each member's `paidAt`
  timestamp; media add-on revenue uses the fixed 150,000 sat price.
  Exact private bookmark item counts are intentionally unavailable to
  the server because private bookmark sets are encrypted client-side.
- **boxes** — Redis, Meilisearch, strfry, Voltage, archive-worker
  (Box B), bunker (Box C). Each carries `ok` + a short status string
  + latencyMs where applicable. Strfry is probed with an EOSE round
  trip on the WS port; Voltage liveness is the last `invoice_updated`
  tick stamped by the subscription handler; the archive-worker
  liveness is the last `/archive/callback` we received.
- **relay** — canonical URL, relay-allowed-pubkey count
  (`dm:registered:pubkeys`), watched-contacts count
  (`dm:contacts:watched`, followed pubkeys queued for server-side
  outbox ingest), per-kind event counters (`dm:relay-counter:<kind>`).
- **queues** — depth of the worker queues:
  `dm:onboarding:queue`, `dm:lifetime-archive:queue`,
  `dm:publish-relay:queue`, `dm:publish-relay:dead`,
  `dm:kind1-fanout:queue`, and `dm:archive:queue` via `LLEN`, plus
  `dm:publish-relay:delayed` via `ZCARD`. (The old
  `dm:pending-publish:queue` gauge was dropped — it watched a key
  nothing wrote and always read 0.)
- **workers** — every worker's public `stats` field (relay-fanout,
  onboarding-scanner, lifetime-archive-backfill, follows-ingester).
- **alerts** — the last 50 entries the Tier-1 alerter has fired
  (mirrored into `dm:alerter:recent`).

The frontend page is at `/app/admin/dashboard`. It only renders for
pubkeys in the server's `ADMIN_PUBKEYS` set; non-admins see "access
denied" from the NIP-98 gate.

### `GET /admin/relay-stats?pubkey=<hex>` (NIP-98 admin)

Cross-checks what's actually on `relay.deepmarks.org` for one pubkey
against what api's Redis cache thinks it has. Built for
"where are my bookmarks?" triage. Returns:

- per-kind event counts on the indexer relay (39701 / 30003 / 10002 / 0 / 3)
- Redis cache state side-by-side: public-bookmarks cache count,
  cached profile name, lifetime-member flag, bookmarks-backfilled
  marker
- the user's NIP-65 advertised relays (parsed from kind:10002)
- a small sample of recent events (kind + id + created_at + d-tag)

Example:

```bash
# Build a kind:27235 NIP-98 event with your admin nsec: tags
#   ["u","https://api.deepmarks.org/admin/relay-stats?pubkey=<hex>"],
#   ["method","GET"],
#   ["nonce","<random>"]
# with created_at in the last 60 s, sign it, base64-encode the JSON,
# and send it as the Authorization header. A NIP-98 builder from nak,
# nostr-tools, or @noble/curves all work.
curl -H "Authorization: Nostr <base64(signed kind:27235 event)>" \
  'https://api.deepmarks.org/admin/relay-stats?pubkey=<hex>'
```

`/admin/relay-stats`, `/admin/dashboard`, `/admin/lifetime/backfill-archives`,
and `/admin/media-archive/{reconcile,members}` are HTTP-only — `admin.mjs`
has no CLI wrappers for them yet (CLI surface today: `members`, `reconcile`,
`stamp`, `status`, `archive-rescue`, `archive-retry`).

### `POST /admin/archive-rescue/run` (NIP-98 admin)

Runs the archive-rescue pass over stored public-webpage failures —
finds and verifies a public alternative (Wayback, scholarly PDF, URL
variant, FixTweet for tweets, LLM/search suggestion) and enqueues the
best candidate. Body (all optional): `{ pubkey, limit, dryRun, force }`.
**Defaults to dry-run** (`dryRun: true`) — pass `dryRun: false` to
enqueue. `limit` is capped at 50; `force` ignores the per-failure claim
lock. Failures whose `jobId` starts with `rescue:` are skipped. Backs
the `archive-rescue` CLI command.

### `POST /admin/archive-failures/retry` (NIP-98 admin)

Re-enqueues terminal public webpage/file archive failures from scratch
(private/media failures are skipped server-side — they need a client
retry). Body (all optional): `{ pubkey, limit, dryRun, force }`.
**Defaults to dry-run**; `limit` is capped at 100. Failures whose
`jobId` starts with `rescue:` are skipped. Backs the `archive-retry`
CLI command.

### `POST /admin/media-archive/reconcile` (NIP-98 admin)

Media-archive add-on equivalent of the lifetime reconcile: pages
through **Settled** BTCPay invoices, filters for
`metadata.deepmarksProduct === "video-archive"` add-on purchases, and
stamps any pubkey Redis is missing. Idempotent. Response shape matches
reconcile: `{ scanned, stamped, skipped, truncated }`.

### `GET /admin/media-archive/members` (NIP-98 admin)

Returns the current media-archive add-on buyer list:
`{ count, members }`.

### `POST /admin/lifetime/backfill-archives` (NIP-98 admin)

Enqueues lifetime public-archive backfill jobs for existing members.
Body (all optional): `{ pubkey, limit, offset }`. With `pubkey` it
backfills a single member (must already be a lifetime member, else 402);
without it, it walks the member list (`limit` ≤ 500, default 500). Per
member it reports `{ enqueued, skipped, scanned, locked }`.

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

Same `ADMIN_PUBKEYS` + NIP-98 auth model applies to both of them.

(There is no `POST /admin/appeals/:token/grant` route — it was removed
rather than left as a 501 stub, since a stub looks like a wired endpoint
to anyone reading the route table. The reversal-of-actions workflow will
live in the separate admin service at `admin.deepmarks.org` when built.)

## Threat model

- **ADMIN_PUBKEYS list is public-safe.** The pubkeys themselves leak no
  authority — only the holder of the matching nsec can sign a valid
  credential.
- **Admin + operational signer are the same pubkey in practice.** A single
  `deepmarks-admin-nsec.txt` on the operator laptop serves two roles:
  locally it signs NIP-98 credentials for `/admin/*` endpoints; a copy
  on Box C (inside the bunker vault) signs zap receipts, lifetime
  labels, and legacy kind:39701 seed events. The public brand/social
  Damus key is separate and signs the daily Pinboard bookmark/social
  post. Rotating means regenerating the nsec, updating
  `ADMIN_PUBKEYS` on Box A, replacing
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


## 2026-06 reliability updates

- **`GET /health/relay`** (public, no auth): write-path probe — 503
  with `wedged: true` when `dm:publish-relay:queue` has work but
  nothing has forwarded to strfry for 15 minutes. Every other probe is
  read-only and stays green through that failure. The uptime checker
  probes it.
- **Dead letters**: `dm:publish-relay:dead` holds events the fanout
  worker gave up on (the client already got its 202 — this list is the
  only record). Each dead-letter fires a debounced email alert.
- **Queue gauges**: the admin dashboard watches
  `dm:publish-relay:queue` / `:delayed` / `:dead` and
  `dm:kind1-fanout:queue` (the old `dm:pending-publish:queue` gauge
  watched a key nothing wrote — it always read 0).
- **LMDB capacity**: resource-check alerts at 70%/85% of strfry's
  10 GB map size; hitting it is a silent total write outage.
- **Replication**: `docs/backup-restore.md` has the replica
  runbook (seed / reconcile / verify counts / firewall prerequisite).
