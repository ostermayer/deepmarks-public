# Deepmarks relay architecture

Four pieces working together: the server-mediated publish model, the
relay-allowed-pubkey writePolicy on strfry, the server-side fan-out
worker, watched-contact ingest, and the onboarding scan. Together they
make Deepmarks feel like publishing to a centralized service while
keeping every event on Nostr.

The product invariant is relay-first reads. If public Nostr content is
needed for a signed-in user's library, friends feed, friend picker,
profile display, or bookmark preview, Deepmarks should try to copy the
signed event into `relay.deepmarks.org` asynchronously before the user
opens the screen. External relays are still queried for discovery and
freshness, but the local relay is the low-latency first point of search.

## TL;DR

- **Clients sign locally and POST to `/publish`.** Web app, iOS,
  Android, and browser extension send signed events to the API; the
  server forwards them to `relay.deepmarks.org` from Box A.
- **Strfry's writePolicy** rejects any event whose author isn't in
  Redis set `dm:registered:pubkeys`. Random pubkeys can read, but
  not write. The set is a relay allowlist, not a logged-in-user count:
  it includes Deepmarks users plus followed curators whose public
  bookmark events the server mirrors for the outbox model.
- **The relay-fanout worker** propagates accepted events to each
  user's NIP-65 write relays, so the bookmarks still appear on
  Damus / Primal / nos.lol / nostr.wine / nostr.land etc.
- **The onboarding scanner** runs once per newly relay-allowed pubkey
  the first time it enters `dm:registered:pubkeys`. For real users,
  this is usually first NIP-98 auth, payment, username claim, or first
  publish. For followed curators, it may be triggered by the follows
  ingester. It pulls any existing bookmark-shape events
  (kind:39701 / 10003 / 30000 / 30003 / 30001) from their NIP-65 set into our
  relay, so a long-time Damus user's existing pins and follow sets show
  up the moment they sign up for Deepmarks.
- **The follows ingester** watches contact lists from users and tracks
  their followed pubkeys in `dm:contacts:watched`. Those followed
  curators are also added to the relay allowlist so their public
  bookmark events can be mirrored into `relay.deepmarks.org` without
  making mobile clients connect to each curator's relays.

## Why server-mediated publish

Earlier the client published to the user's full NIP-65 set in parallel
and waited for all of them to ack. With flaky third-party relays
(nos.lol, nostr.wine, primal, damus, nostr.land all close connections
mid-publish on iOS WKWebView at least sometimes), saves sat at
"Saving..." for 10+ seconds on iOS and sometimes never resolved at
all. The user-facing symptom was: share a bookmark, wait, see the
toast eventually, find the entry didn't appear in the list because
the publish promise hadn't actually resolved.

Switching to server-mediated publish:

| Before                                   | After                                |
|------------------------------------------|--------------------------------------|
| Client opens 6+ publish WebSockets       | Client POSTs one signed event        |
| Wait for slowest relay or 12s timeout    | Wait for the `/publish` queue accept |
| Save can fail if any single relay errors | Save fails only if the API rejects or is unreachable |
| Cross-relay propagation is client work   | Cross-relay propagation is server work (decoupled from save UX) |

Server-side fan-out is asynchronous, so a slow `nos.lol` no longer
blocks the user.

## Who can publish: the relay-allowed-pubkey set

```
Redis set: dm:registered:pubkeys
```

A pubkey lands in this set the first time *any* of the following happen:

- successful NIP-98 auth on any api route (the catch-all)
- `lifetimeStore.markPaid` (BTCPay settlement, admin stamp)
- `usernameStore.claim` (lifetime members claim a handle)
- `cachePublicBookmarkEvent` (ingest of a kind:39701 event for this
  author, whether via `/bookmarks/public` POST or strfry indexer)
- `follows-ingester` mirrors a followed curator's public bookmark events

When an active user publishes or imports bookmark-shaped events, the
API also schedules a deduplicated friend-cache warm-up. If the user's
follow list is already cached, those followed pubkeys are added to
`dm:contacts:watched` and their ingest timestamps are cleared so the
next follows-ingester pass prioritizes them. If the follow list is not
cached yet, the user is queued for a bounded onboarding refresh so their
kind:3 contact list can be imported before they open the friends feed.

A one-time backfill runs on every api boot to pull in
existing lifetime members, username holders, and known bookmark
authors so the set is consistent with reality after this lands.

Important dashboard semantics:

- `SCARD dm:registered:pubkeys` is **not** "users who logged in".
  It is the number of pubkeys strfry is currently allowed to persist
  events for.
- Actual product/user metrics should use account, payment, and username
  stores: `dm:pk:*`, `dm:lifetime:*`, `dm:username:bypubkey`, BTCPay
  settled invoices, and media-add-on entitlements.
- `SCARD dm:contacts:watched` is the outbox ingest frontier: the
  followed pubkeys that the server periodically checks for public
  Deepmarks/Nostr bookmark events.

The strfry writePolicy plugin (`deploy/box-a/strfry/deepmarks.js`)
checks `SISMEMBER dm:registered:pubkeys <pubkey>` on every event.
Team pubkeys (admin + public brand) skip the check; NIP-46 messages
(kind:24133) also skip since the bunker uses ephemeral session keys.

The plugin has a 60s local positive cache and a 5s negative cache
per pubkey, so the hot path doesn't round-trip Redis for every
event. On Redis errors the plugin fails open — better to briefly
accept an unregistered event during an outage than to bounce a
paying user's save.

## Allowed event kinds

Even from relay-allowed pubkeys, the writePolicy only accepts kinds we
explicitly support:

| Kind   | Why                                                                |
|-------:|--------------------------------------------------------------------|
| 0      | profile metadata (avatar + Lightning address from settings)        |
| 3      | NIP-02 contact list (server uses for outbox + autocomplete)        |
| 5      | NIP-09 deletion requests                                           |
| 10000  | NIP-51 mute list                                                   |
| 10002  | NIP-65 relay list                                                  |
| 10003  | NIP-51 legacy single bookmark list (Damus / Primal / Amethyst notes) |
| 30000  | NIP-51 categorized follow sets (`deepmarks-friends`)               |
| 30001  | NIP-51 deprecated "categorized bookmarks/sets" — legacy predecessor of 30003, mirrored so older clients' bookmark sets import |
| 30003  | encrypted private bookmark chunks, explicit collections, archive-keys, and third-party NIP-51 bookmark sets |
| 39701  | public web bookmarks                                               |
| 9735   | NIP-57 zap receipts                                                |
| 1985   | NIP-32 lifetime-member labels (admin-only)                         |
| 24133  | NIP-46 nostr-connect plumbing (Box C bunker)                       |

The public brand pubkey gets a slightly wider allowlist (kind:1 /
6 / 7 / 30023) so it can run a Nostr presence — release
notes, replies, profile, etc.

Anything else returns a `reject` with reason `kind <N> not accepted
on this relay`.

### kind:1 cross-post and friend link notes

`kind:1` from a non-team registered user is a special case. The
client POSTs the signed note to `/publish`, so when the user composes
a Nostr cross-post alongside a bookmark save we need to accept the
publish without turning our relay into a general-purpose text-note store.

The writePolicy:

1. Runs the relay-allowed-pubkey + rate-limit gates as usual.
2. If the author is in `dm:contacts:watched` and the note contains an
   `http(s)` URL, accepts the note so `/app/friends` can render only the
   extracted link for users who selected that author as a friend.
3. If `follows-ingester` has seen a watched friend's NIP-51 bookmark list
   reference this exact note id, accepts that signed target event. The
   worker sets `dm:bookmarked-note-target:<eventId>` with a 30-day TTL
   immediately before forwarding the note to strfry.
4. Otherwise `LPUSH`es the raw event JSON onto
   `dm:kind1-fanout:queue` (capped at 10,000 entries to bound the
   keyspace).
5. Returns `shadowReject` for fanout-only notes — strfry tells the
   publisher "ok" but never writes the event to LMDB.

The relay-fanout worker has a dedicated BRPOP loop that drains
`dm:kind1-fanout:queue` and broadcasts each event to the author's
NIP-65 write relays (cached the same way as bookmark fan-out). The
net effect: the user posts through one API call; their note reaches every
client they care about (Damus, Primal, nos.lol …). Stored kind:1 notes
are limited to watched pubkeys with links and are never used by global,
popular, recent, or public profile feeds.

## Server-side fan-out

`api/src/workers/relay-fanout.ts` subscribes to strfry for
kinds [0, 1, 3, 5, 10000, 10002, 10003, 30000, 30003, 39701] starting at
worker boot. For each event:

1. Look up the author's NIP-65 write relays (kind:10002) from strfry. Cache the
   relay list in Redis (`dm:relay-fanout:nip65:<pubkey>`, 6h TTL,
   5min negative cache).
2. Filter out the canonical relay (don't fan out to ourselves) and
   obvious junk (single-label hosts, IP literals, localhost).
3. Keep kind:30000 follow sets only when they are addressable (`d`
   tag present).
4. Filter kind:30003 to bookmark-shape sets (Deepmarks d-tags OR
   tags carrying `e` / `a` / `r` references). Skip generic NIP-51
   non-bookmark sets.
5. Publish in parallel to each target (cap 12 relays per event, 4s
   per-target timeout).

Defenses:

- LRU(20000) dedupe by event id so a loop-back doesn't trigger a
  second fan-out
- Per-pubkey rate limit: 200 fan-outs / 60s. Stops a runaway
  publisher from hammering third-party relays through us.
- SimplePool reuses outbound WebSockets in the fan-out worker —
  fan-out to a popular relay shares one connection across all users.

## Watched-contact ingest

`api/src/workers/follows-ingester.ts` watches kind:3 contact
lists and kind:30000 follow sets from relay-allowed Deepmarks users.
For each follow source:

1. For kind:3 only, store the user's followed pubkeys in
   `dm:follows:by-user:<pubkey>` for contacts autocomplete.
2. Union all followed/friend pubkeys into `dm:contacts:watched`.
3. Periodically pick watched pubkeys whose last ingest is oldest.
4. Resolve each curator's NIP-65 relays, then query the latest profile
   metadata (`kind:0`) and public bookmark/list kinds
   `[39701, 30000, 30003, 10003]`. The first pass is historical so a new
   friend's existing bookmarks are available from the Deepmarks relay
   without waiting for that friend to publish again.
5. Mirror note targets referenced by NIP-51 `e` tags through exact-id
   lookups, plus kind:1 notes that contain `http(s)` links when raw
   social posts are explicitly enabled by the viewer.
6. Register the curator in `dm:registered:pubkeys` before forwarding
   their events to strfry, because the relay writePolicy gates on
   author membership in that set.

The ingester also writes profile metadata into the Redis profile cache
as soon as a `kind:0` event is seen. That keeps friend pickers and feed
bylines from falling back to npubs while the app waits for a separate
profile lookup.

The `/publish` path mirrors the same follow-source write into Redis for
kind:3 and kind:30000 events before the queued relay publish completes.
That keeps freshly edited friend lists from waiting on the local strfry
subscription before the cache pipeline sees the new pubkeys.

The query path uses guarded raw WebSocket parsing for outbound relay
reads. Public relays occasionally emit malformed frames; malformed JSON
or non-Nostr events are ignored so a bad third-party relay cannot crash
api and trigger repeated startup handshakes.

## Onboarding scan

`api/src/workers/onboarding-scanner.ts` triggers the first
time a pubkey is added to `dm:registered:pubkeys` (via
`LPUSH dm:onboarding:queue`). It:

1. Looks up the user's NIP-65 — first from our relay, then falling
   back to common public relays (damus, nos.lol, primal,
   nostr.wine, nostr.land) if we haven't seen one yet.
2. Queries those relays for events: `kinds:[39701, 10003, 30000, 30003, 30001]`,
   `authors:[user pubkey]`, limit 5000, 8s timeout.
3. Filters kind:30003 to Deepmarks d-tags AND any third-party
   bookmark-shape set (has `e` / `a` / `r` tags). Drops mute lists,
   people lists, etc.
4. Fetches kind:1 note targets referenced by kept NIP-51 `e` tags,
   marks each exact event id as a temporary bookmarked-note target, and
   forwards those signed notes too.
5. Forwards each kept event to our local strfry. They're already
   signed; the writePolicy accepts (the user just registered) and
   the fanout worker mirrors them back out to the user's NIP-65.

The result for the user: sign up for Deepmarks with a 5-year-old
Damus pubkey, and within seconds your existing public bookmarks +
pinned notes are visible in `/app/bookmarks` and `/app/posts`.

A 30-day marker key (`dm:onboarding:done:<pubkey>`) prevents
re-scanning the same pubkey.

## Lifetime-archive backfill

`api/src/workers/lifetime-archive-backfill.ts` triggers the
first time `lifetimeStore.markPaid` writes a value (BTCPay settlement
or admin stamp). It:

1. Loads up to 250 of the user's cached public bookmarks.
2. For each that lacks a `blossomHash` / `waybackUrl` /
   `archive-tier=forever` tag, calls `enqueueLifetimeArchive` to
   spin up an archive job on Box B.
3. 1-year marker key (`dm:lifetime-archive:done:<pubkey>`) so a
   second BTCPay settlement / admin stamp doesn't re-enqueue.

The existing client-side `lib/nostr/lifetime-archive-backfill.ts`
still handles the long tail (anything past the 250-event server cap,
and anything saved after settlement). This worker just bootstraps the
first batch so paid users see archives appearing without needing to
open a Deepmarks surface post-settlement.

## End-to-end flow

```
User saves a bookmark (web / iOS / extension / app)
        │
        ▼
  Client signs the event and POSTs it to api.deepmarks.org/publish
        │
        ▼
  api queues the signed event and forwards it from Box A
  to relay.deepmarks.org / ws://strfry:7777
        │
        ▼
  Strfry writePolicy plugin
   1. event.kind in ALLOWED_KINDS?              → reject otherwise
   2. SISMEMBER dm:registered:pubkeys author?   → reject otherwise
   3. Per-pubkey rate limit OK?                 → reject otherwise
        │ accept
        ▼
  Strfry persists; api's indexer + cache pick it up
        │
        ▼
  relay-fanout worker subscribes; pushes the event to
  each NIP-65 write relay the author advertises
        │
        ▼
  Damus / Primal / nos.lol / nostr.wine / nostr.land users
  see the bookmark on their preferred clients
```

```
User signs up for Deepmarks (first NIP-98 auth, lifetime payment,
username claim, or first kind:39701 publish via our API)
        │
        ▼
  registerPubkey SADDs to dm:registered:pubkeys
   - SADD returns 1 (new) → LPUSH dm:onboarding:queue
        │
        ▼
  onboarding-scanner worker BRPOPs the queue
   - Find NIP-65 (our relay → common relays fallback)
   - Query kinds:[0,3,39701,10003,30000,30003,30001] from those relays
   - Fetch note targets referenced by NIP-51 e-tags
   - Forward to strfry; writePolicy accepts
        │
        ▼
  fanout worker observes the imported events; mirrors them
  back out to the user's NIP-65 write relays
        │
        ▼
  User opens Deepmarks for the first time and sees their entire
  pre-Deepmarks bookmark history already in /app/bookmarks +
  /app/posts
```

## Operational levers

| Env var on Box A                  | Default     | What it controls                                         |
|-----------------------------------|-------------|----------------------------------------------------------|
| `STRFRY_RATE_LIMIT_PER_HOUR`      | 200         | Per-pubkey publish cap on the relay (set on the `strfry` container) |
| `CANONICAL_RELAY_URL`             | `wss://relay.deepmarks.org` | What the fanout worker considers "us" (never fan out to self). Post worker-split this lives on the `worker-relay-sync` container, not `api` |
| `REDIS_URL`                       | (.env)      | Strfry plugin's Redis connection (password-protected)    |

Inspect runtime state from any admin shell:

```
docker exec box-a-redis-1 redis-cli -a "$REDIS_PASSWORD" --no-auth-warning \
  SCARD dm:registered:pubkeys                # relay allowlist size, not user count
  SISMEMBER dm:registered:pubkeys <pubkey>   # can strfry persist this author's events?
  SCARD dm:contacts:watched                  # followed curators tracked for outbox ingest
  HLEN dm:username:bypubkey                  # active short-handle claims
  LLEN dm:onboarding:queue                   # onboarding backlog
  LLEN dm:lifetime-archive:queue             # archive backfill backlog
```

`/admin/relay-stats?pubkey=<hex>` reports per-pubkey relay + cache
state side-by-side (NIP-98-gated; see [`admin.md`](admin.md)).


## 2026-06 reliability updates

Rate-limit scopes in `deploy/box-a/strfry/deepmarks.js` (all env-tunable):

| Scope | Applies to | Default |
|---|---|---|
| `bookmarks` | kind:39701 | 1000/h (`STRFRY_BOOKMARK_RATE_LIMIT_PER_HOUR`) — imports died in the old shared 200/h bucket |
| `private-state` | kind:30003 `deepmarks-private*` (chunks AND `deepmarks-private-item:` per-item events/tombstones), `deepmarks-collection-private:*`, `deepmarks-archive-keys*`, `deepmarks-nwc` | 5000/h |
| `general` | everything else | 200/h |

Buckets count ACCEPTED events only — rejected attempts no longer burn
the window (retries used to starve themselves). The relay-fanout worker
retries rate-limited events on a 30-attempt budget (~24h of backoff),
dead-letters deterministic policy rejections immediately to
`dm:publish-relay:dead` (operator alert + inspect with LRANGE,
re-inject by LPUSHing the inner `event` back onto
`dm:publish-relay:queue`), and stamps `dm:publish-relay:last-forward-ts`
for the `GET /health/relay` write-path probe (503 = wedged).
`rejectEventsOlderThanSeconds` is 10 years so onboarding scans stop
bouncing long-time users' original events. The strfry image is pinned
to the production commit — bump deliberately. Full context:
[`reliability-2026-06.md`](reliability-2026-06.md).
