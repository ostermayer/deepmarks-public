# Deepmarks relay architecture

Four pieces working together: the server-mediated publish model, the
registered-pubkey writePolicy on strfry, the server-side fan-out
worker, and the onboarding scan. Together they make Deepmarks feel
like publishing to a centralized service while keeping every event
on Nostr.

## TL;DR

- **Clients sign locally and POST to `/publish`.** Web app, iOS,
  Android, and browser extension send signed events to the API; the
  server forwards them to `relay.deepmarks.org` from Box A.
- **Strfry's writePolicy** rejects any event whose author isn't in
  Redis set `dm:registered:pubkeys`. Random pubkeys can read, but
  not write. Registered Deepmarks users can write from any client.
- **The relay-fanout worker** propagates accepted events to each
  user's NIP-65 write relays, so the bookmarks still appear on
  Damus / Primal / nos.lol / nostr.wine / nostr.land etc.
- **The onboarding scanner** runs once per pubkey the first time
  they register. It pulls any existing bookmark-shape events
  (kind:39701 / 30003 / 10003) from their NIP-65 set into our
  relay, so a long-time Damus user's existing pins show up the
  moment they sign up for Deepmarks.

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

## Who can publish: the registered-pubkey set

```
Redis set: dm:registered:pubkeys
```

A pubkey lands in this set the first time *any* of the following
happen:

- successful NIP-98 auth on any payment-proxy route (the catch-all)
- `lifetimeStore.markPaid` (BTCPay settlement, admin stamp)
- `usernameStore.claim` (lifetime members claim a handle)
- `cachePublicBookmarkEvent` (ingest of a kind:39701 event for this
  author, whether via `/bookmarks/public` POST or strfry indexer)

A one-time backfill runs on every payment-proxy boot to pull in
existing lifetime members, username holders, and known bookmark
authors so the set is consistent with reality after this lands.

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

Even from registered pubkeys, the writePolicy only accepts kinds we
explicitly support:

| Kind   | Why                                                                |
|-------:|--------------------------------------------------------------------|
| 0      | profile metadata (avatar + Lightning address from settings)        |
| 3      | NIP-02 contact list (server uses for outbox + autocomplete)        |
| 5      | NIP-09 deletion requests                                           |
| 10000  | NIP-51 mute list                                                   |
| 10002  | NIP-65 relay list                                                  |
| 10003  | NIP-51 legacy single bookmark list (Damus / Primal / Amethyst notes) |
| 30003  | encrypted private bookmark chunks + archive-keys + third-party NIP-51 bookmark sets |
| 39701  | public web bookmarks                                               |
| 9735   | NIP-57 zap receipts                                                |
| 1985   | NIP-32 lifetime-member labels (admin-only)                         |
| 24133  | NIP-46 nostr-connect plumbing (Box C bunker)                       |

The public brand pubkey gets a slightly wider allowlist (kind:1 /
6 / 7 / 30023) so it can run a Nostr presence — release
notes, replies, profile, etc.

Anything else returns a `reject` with reason `kind <N> not accepted
on this relay`.

### kind:1 cross-post (publish-only, never stored)

`kind:1` from a non-team registered user is a special case. The
client POSTs the signed note to `/publish`, so when the user composes
a Nostr cross-post alongside a bookmark save we need to accept the
publish without turning our relay into a general-purpose text-note
store.

The writePolicy:

1. Runs the registered-pubkey + rate-limit gates as usual.
2. `LPUSH`es the raw event JSON onto `dm:kind1-fanout:queue` (capped
   at 10,000 entries to bound the keyspace).
3. Returns `shadowReject` — strfry tells the publisher "ok" but
   never writes the event to LMDB.

The relay-fanout worker has a dedicated BRPOP loop that drains
`dm:kind1-fanout:queue` and broadcasts each event to the author's
NIP-65 write relays (cached the same way as bookmark fan-out). The
net effect: the user posts through one API call; their note reaches every
client they care about (Damus, Primal, nos.lol …) without us
storing the text-note ourselves.

## Server-side fan-out

`payment-proxy/src/workers/relay-fanout.ts` subscribes to strfry for
kinds [0, 3, 5, 10000, 10002, 10003, 30003, 39701] starting at
worker boot. For each event:

1. Look up the author's NIP-65 write relays (kind:10002) from strfry. Cache the
   relay list in Redis (`dm:relay-fanout:nip65:<pubkey>`, 6h TTL,
   5min negative cache).
2. Filter out the canonical relay (don't fan out to ourselves) and
   obvious junk (single-label hosts, IP literals, localhost).
3. Filter kind:30003 to bookmark-shape sets (Deepmarks d-tags OR
   tags carrying `e` / `a` / `r` references). Skip generic NIP-51
   non-bookmark sets.
4. Publish in parallel to each target (cap 12 relays per event, 4s
   per-target timeout).

Defenses:

- LRU(20000) dedupe by event id so a loop-back doesn't trigger a
  second fan-out
- Per-pubkey rate limit: 200 fan-outs / 60s. Stops a runaway
  publisher from hammering third-party relays through us.
- SimplePool reuses outbound WebSockets — fan-out to a popular
  relay shares one connection across all users.

## Onboarding scan

`payment-proxy/src/workers/onboarding-scanner.ts` triggers the first
time a pubkey is added to `dm:registered:pubkeys` (via
`LPUSH dm:onboarding:queue`). It:

1. Looks up the user's NIP-65 — first from our relay, then falling
   back to common public relays (damus, nos.lol, primal,
   nostr.wine, nostr.land) if we haven't seen one yet.
2. Queries those relays for events: `kinds:[39701, 10003, 30003]`,
   `authors:[user pubkey]`, limit 5000, 8s timeout.
3. Filters kind:30003 to Deepmarks d-tags AND any third-party
   bookmark-shape set (has `e` / `a` / `r` tags). Drops mute lists,
   people lists, etc.
4. Forwards each kept event to our local strfry. They're already
   signed; the writePolicy accepts (the user just registered) and
   the fanout worker mirrors them back out to the user's NIP-65.

The result for the user: sign up for Deepmarks with a 5-year-old
Damus pubkey, and within seconds your existing public bookmarks +
pinned notes are visible in `/app/bookmarks` and `/app/posts`.

A 30-day marker key (`dm:onboarding:done:<pubkey>`) prevents
re-scanning the same pubkey.

## Lifetime-archive backfill

`payment-proxy/src/workers/lifetime-archive-backfill.ts` triggers the
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
  payment-proxy queues the signed event and forwards it from Box A
  to relay.deepmarks.org / ws://strfry:7777
        │
        ▼
  Strfry writePolicy plugin
   1. event.kind in ALLOWED_KINDS?              → reject otherwise
   2. SISMEMBER dm:registered:pubkeys author?   → reject otherwise
   3. Per-pubkey rate limit OK?                 → reject otherwise
        │ accept
        ▼
  Strfry persists; payment-proxy's indexer + cache pick it up
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
   - Query kinds:[39701,10003,30003] from those relays
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
| `STRFRY_RATE_LIMIT_PER_HOUR`      | 200         | Per-pubkey publish cap on the relay                      |
| `CANONICAL_RELAY_URL`             | `wss://relay.deepmarks.org` | What the fanout worker considers "us" (never fan out to self) |
| `REDIS_URL`                       | (.env)      | Strfry plugin's Redis connection (password-protected)    |

Inspect runtime state from any admin shell:

```
docker exec box-a-redis-1 redis-cli -a "$REDIS_PASSWORD" --no-auth-warning \
  SCARD dm:registered:pubkeys                # how many users registered
  SISMEMBER dm:registered:pubkeys <pubkey>   # is one specific user registered
  LLEN dm:onboarding:queue                   # onboarding backlog
  LLEN dm:lifetime-archive:queue             # archive backfill backlog
```

`/admin/relay-stats?pubkey=<hex>` reports per-pubkey relay + cache
state side-by-side (NIP-98-gated; see [`admin.md`](admin.md)).
