#!/usr/bin/env node
// strfry writePolicy plugin — accepts only the kinds Deepmarks actually
// uses this relay to carry. Anything else is rejected to keep the relay
// narrowly scoped (it's not a general-purpose public relay).
//
//   0      NIP-01 profile metadata for relay-allowed pubkeys
//   5      NIP-09 deletion requests for relay-allowed pubkeys
//   39701  NIP-B0 public web bookmarks (the headline event kind)
//   30000  NIP-51 categorized follow sets (Deepmarks friends subset)
//   30003  NIP-51 private bookmark sets (encrypted-to-self via NIP-44 v2 —
//          our relay needs to accept these so the extension and web app
//          can use us as their canonical private-sync relay too, not just
//          for public bookmarks. Content is opaque ciphertext to us.)
//   10000  NIP-51 mute lists
//   9735   NIP-57 zap receipts
//   1985   NIP-32 lifetime-member labels (admin/operational signer durability layer)
//   24133  NIP-46 nostr-connect messages (payment-proxy ↔ Box C bunker)
//
// Kind 24133 is the plumbing that keeps nsecs off Box A: payment-proxy
// and the bunker relay encrypted sign requests + responses through this
// strfry over the VPC. Without it in the allowlist the bunker handshake
// can't complete.
//
// Hardening (added 2026-04-25):
//   - Parse failure now responds with an explicit reject — strfry's
//     plugin protocol expects one response line per input; a bare
//     `return` left strfry with undefined behavior.
//   - Kind 1985 is gated to the admin/operational pubkey only. Anyone can publish
//     a NIP-32 label on Nostr generally, but the UI only treats
//     admin-signed lifetime labels as authoritative — letting them
//     pile up here is just relay bloat / impersonation footgun.
//   - Per-pubkey events/hour cap. In-memory map lives for the plugin
//     process lifetime; resets on strfry restart. Stops a single noisy
//     pubkey from filling the LMDB volume.

'use strict';

// Kinds any relay-allowed user/curator may publish on this relay.
//   0      NIP-01 profile metadata (avatar / lightning address edits)
//   5      NIP-09 deletion requests for the user's own events
//   39701  NIP-B0 public web bookmarks
//   30000  NIP-51 categorized follow sets (friends lists)
//   30003  NIP-51 generic encrypted bookmark sets (our private set
//          + archive-keys set, plus any user-imported sets like
//          "reading" / "research" from third-party clients)
//   10003  NIP-51 legacy single bookmark list (Damus, Amethyst, Primal,
//          Snort all use this for "bookmarked notes" / pinned posts)
//   3      NIP-02 contact list — accepted from relay-allowed users so the
//          server-side outbox worker (workers/follows-ingester.ts) can
//          watch who each user follows and pull those curators' content
//          into our relay on the user's behalf
//   10000  NIP-51 mute list — settings UI republishes this through /publish
//   10002  NIP-65 relay list — same idea. Lets us know each user's
//          read/write relay preferences without a separate fetch.
//   9735   NIP-57 zap receipts
//   1985   NIP-32 lifetime-member labels (admin)
//   24133  NIP-46 nostr-connect (bunker plumbing)
//
// Note: kind:1 is deliberately NOT in this list. We don't want to
// be a general-purpose text-note relay — relay.deepmarks.org stores
// bookmarks, team posts, and watched friends' link notes only.
// Registered users CAN still post kind:1 through our endpoint (so the
// mobile/web app can publish to one socket). Most kind:1 events are
// pushed onto a fanout queue and shadowRejected so strfry never
// persists them. Link-containing kind:1 notes from watched pubkeys are
// accepted so /app/friends can show links friends posted from other
// Nostr clients without showing the surrounding social commentary.
const ALLOWED_KINDS = new Set([0, 5, 39701, 30000, 30003, 10003, 3, 10000, 10002, 9735, 1985, 24133]);

/** Redis LIST the kind:1 fanout worker consumes. Each entry is the
 *  raw JSON event the writePolicy received. */
const KIND1_FANOUT_QUEUE = 'dm:kind1-fanout:queue';
const KIND1_FANOUT_QUEUE_CAP = 10_000;
const WATCHED_CONTACTS_SET = 'dm:contacts:watched';
const BOOKMARKED_NOTE_TARGET_PREFIX = 'dm:bookmarked-note-target:';

// Extra kinds the public brand/social pubkey may publish — lets the
// project run a Nostr presence on this relay (announcements, replies,
// reposts, reactions, profile, relay list, optional long-form) without
// opening those kinds to the general public. The admin/operational signer
// does not get these social privileges.
const TEAM_EXTENDED_KINDS = new Set([
  0,      // NIP-01 profile metadata (name, about, picture, lud16)
  1,      // NIP-01 text notes (announcements + replies)
  3,      // NIP-02 contact list (who the team follows)
  6,      // NIP-18 reposts (amplify community bookmarks)
  7,      // NIP-25 reactions (likes / emoji)
  10002,  // NIP-65 relay list metadata
  30023,  // NIP-23 long-form articles (release notes, postmortems)
]);

const ADMIN_PUBKEY = (
  process.env.DEEPMARKS_ADMIN_PUBKEY ??
  process.env.DEEPMARKS_BRAND_PUBKEY ??
  ''
).toLowerCase();
const PUBLIC_BRAND_PUBKEY = (process.env.DEEPMARKS_PUBLIC_BRAND_PUBKEY ?? '').toLowerCase();
const TEAM_PUBKEYS = new Set([ADMIN_PUBKEY, PUBLIC_BRAND_PUBKEY].filter(Boolean));
const RATE_LIMIT_PER_HOUR = Number.parseInt(
  process.env.STRFRY_RATE_LIMIT_PER_HOUR ?? '200',
  10,
);
const PRIVATE_STATE_RATE_LIMIT_PER_HOUR = Number.parseInt(
  process.env.STRFRY_PRIVATE_STATE_RATE_LIMIT_PER_HOUR ?? '5000',
  10,
);
const RATE_WINDOW_MS = 60 * 60 * 1000;

// Relay-allowed-pubkey gate. Deepmarks-relay-first means we accept events
// from third-party clients, but we only persist them when the author
// is in the Redis allowlist. The historical key name is
// dm:registered:pubkeys, but it is not a pure logged-in-user count:
// payment-proxy adds real Deepmarks users and followed curators whose
// public bookmark events are mirrored by the server-side outbox worker.
//
// The registry lives in Redis as a set: dm:registered:pubkeys
//   SISMEMBER dm:registered:pubkeys <hex-pubkey>  → 1 if allowed
//
// Team pubkeys (ADMIN + PUBLIC_BRAND) always pass without a Redis
// hit — they're the operational signers and must work even if Redis
// hiccups.
//
// On Redis unavailability we fail OPEN (accept) for kinds in
// ALLOWED_KINDS. Worse to silently drop a paying member's save than
// to briefly accept an unregistered event during an outage; the
// follow-up indexer + relay-fanout still only act on entries the
// fanout cache recognizes.
const REGISTRY_SET_KEY = 'dm:registered:pubkeys';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';
const REGISTRY_CACHE_TTL_MS = 60 * 1000; // local positive cache so hot pubkeys don't round-trip per event
const REGISTRY_NEGATIVE_TTL_MS = 5 * 1000;
const registryCache = new Map(); // pubkey -> { registered: boolean, expiresAt: number }

let redisClient = null;
let Redis = null;
try {
  Redis = require('ioredis');
} catch (e) {
  process.stderr.write(
    `deepmarks.js: ioredis not available (${e.message}); registry check disabled — accepting all events\n`,
  );
}

function getRedis() {
  if (!Redis) return null;
  if (redisClient) return redisClient;
  try {
    redisClient = new Redis(REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      // Don't crash the plugin if Redis hiccups — fail open instead.
      reconnectOnError: () => true,
    });
    redisClient.on('error', (err) => {
      process.stderr.write(`deepmarks.js: redis error ${err.message}\n`);
    });
  } catch (err) {
    process.stderr.write(`deepmarks.js: redis init failed ${err.message}\n`);
    redisClient = null;
  }
  return redisClient;
}

async function isRegistered(pubkey) {
  const cached = registryCache.get(pubkey);
  if (cached && cached.expiresAt > Date.now()) return cached.registered;
  const client = getRedis();
  if (!client) return true; // ioredis not installed — fail open
  try {
    const result = await client.sismember(REGISTRY_SET_KEY, pubkey);
    const registered = result === 1;
    registryCache.set(pubkey, {
      registered,
      expiresAt: Date.now() + (registered ? REGISTRY_CACHE_TTL_MS : REGISTRY_NEGATIVE_TTL_MS),
    });
    return registered;
  } catch (err) {
    process.stderr.write(`deepmarks.js: SISMEMBER failed ${err.message} — accepting\n`);
    return true; // fail open on Redis errors
  }
}

async function isWatchedContact(pubkey) {
  const client = getRedis();
  if (!client) return false;
  try {
    const result = await client.sismember(WATCHED_CONTACTS_SET, pubkey);
    return result === 1;
  } catch (err) {
    process.stderr.write(`deepmarks.js: watched contact check failed ${err.message}\n`);
    return false;
  }
}

async function isBookmarkedNoteTarget(eventId) {
  const client = getRedis();
  if (!client) return false;
  try {
    const result = await client.get(BOOKMARKED_NOTE_TARGET_PREFIX + eventId);
    return result === '1';
  } catch (err) {
    process.stderr.write(`deepmarks.js: bookmarked note target check failed ${err.message}\n`);
    return false;
  }
}

function hasHttpUrl(content) {
  return typeof content === 'string' && /\bhttps?:\/\/\S+/i.test(content);
}

if (!ADMIN_PUBKEY) {
  // Without the admin/operational pubkey we can't enforce the kind:1985 gate.
  // Refuse to start so the operator notices instead of silently
  // accepting forged labels from anyone.
  process.stderr.write(
    'deepmarks.js: DEEPMARKS_ADMIN_PUBKEY is unset — refusing to start writePolicy\n',
  );
  process.exit(1);
}
if (!PUBLIC_BRAND_PUBKEY) {
  process.stderr.write(
    'deepmarks.js: DEEPMARKS_PUBLIC_BRAND_PUBKEY is unset — public brand/social key will not get extended-kind privileges\n',
  );
}
/** scope:pubkey → { count, windowStart }. Sliding hour-long buckets. */
const buckets = new Map();

function rateLimitOk(pubkey, limit = RATE_LIMIT_PER_HOUR, scope = 'general') {
  const now = Date.now();
  const key = `${scope}:${pubkey}`;
  let b = buckets.get(key);
  if (!b || now - b.windowStart > RATE_WINDOW_MS) {
    b = { count: 0, windowStart: now };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count <= limit;
}

function rateLimitForEvent(event) {
  if (event.kind !== 30003) {
    return { limit: RATE_LIMIT_PER_HOUR, scope: 'general' };
  }
  const d = tagValue(event.tags, 'd') ?? '';
  if (
    d === 'deepmarks-archive-keys' ||
    /^deepmarks-archive-keys-\d+$/.test(d) ||
    d === 'deepmarks-private' ||
    /^deepmarks-private-\d+$/.test(d) ||
    d === 'deepmarks-nwc'
  ) {
    return { limit: PRIVATE_STATE_RATE_LIMIT_PER_HOUR, scope: 'private-state' };
  }
  return { limit: RATE_LIMIT_PER_HOUR, scope: 'general' };
}

function tagValue(tags, name) {
  return Array.isArray(tags) ? tags.find((t) => t[0] === name)?.[1] : undefined;
}

// Best-effort housekeeping: every 10 minutes, drop any bucket whose
// window has fully elapsed. Cheap to skip — bounded by active-pubkey
// count which is small for our scale.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (now - b.windowStart > RATE_WINDOW_MS) buckets.delete(k);
  }
}, 10 * 60 * 1000).unref();

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });

function respond(id, action, msg) {
  const payload = msg ? { id, action, msg } : { id, action };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

rl.on('line', async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    // strfry's plugin protocol REQUIRES one response line per input.
    // A bare `return` leaves strfry waiting and leads to undefined
    // behavior on subsequent events (some builds shadow-accept).
    respond('', 'reject', 'malformed request');
    return;
  }

  const event = req?.event;
  if (!event || typeof event.kind !== 'number' || typeof event.pubkey !== 'string') {
    respond(event?.id ?? '', 'reject', 'malformed event');
    return;
  }

  // Two-tier kind allowlist:
  //   1. ALLOWED_KINDS — open to any REGISTERED publisher (project's
  //      headline kinds + the bunker plumbing).
  //   2. TEAM_EXTENDED_KINDS — only when the publisher is a known
  //      Deepmarks team key. The public brand/social key is the expected
  //      publisher for kind:0/1/3/6/7/10002/30023.
  const pubkeyLc = event.pubkey.toLowerCase();
  const fromTeam = TEAM_PUBKEYS.has(pubkeyLc);

  // Kind:1 from a non-team registered user is normally a CROSS-POST
  // through our relay, not a request to store. The user's mobile/web
  // client stays connected to relay.deepmarks.org only; we asynchronously
  // mirror the note out to their NIP-65 advertised relays so it reaches
  // the rest of Nostr (Damus, Primal, nos.lol, …).
  //
  // Exception: if the author is in the watched-contact set and the note
  // contains an http(s) URL, persist it. The friends page filters by the
  // viewer's Deepmarks friends and renders only extracted links, never
  // the surrounding social text. Non-link notes still never persist.
  // Second exception: if follows-ingester has seen a watched friend's
  // NIP-51 bookmark list reference this exact note id, persist that
  // signed target event so Deepmarks can render bookmarked posts from
  // our relay without re-querying old third-party relays.
  //
  // Flow: relay-allowlist check first (avoid building a queue of spam
  // from unallowed pubkeys), then either accept a watched link-note or
  // push to the fanout queue and shadowReject. The kind:1-fanout worker
  // BRPOPs the queue and broadcasts shadowRejected notes.
  if (event.kind === 1 && !fromTeam) {
    if (await isBookmarkedNoteTarget(event.id)) {
      respond(event.id, 'accept');
      return;
    }
    const registered = await isRegistered(pubkeyLc);
    if (!registered) {
      respond(event.id, 'reject', 'pubkey not registered with deepmarks — sign in at https://deepmarks.org first');
      return;
    }
    if (!rateLimitOk(event.pubkey, RATE_LIMIT_PER_HOUR, 'general')) {
      respond(event.id, 'reject', `rate limit (${RATE_LIMIT_PER_HOUR}/hour per pubkey)`);
      return;
    }
    if (hasHttpUrl(event.content) && await isWatchedContact(pubkeyLc)) {
      respond(event.id, 'accept');
      return;
    }
    const client = getRedis();
    if (client) {
      try {
        await client.multi()
          .lpush(KIND1_FANOUT_QUEUE, JSON.stringify(event))
          .ltrim(KIND1_FANOUT_QUEUE, 0, KIND1_FANOUT_QUEUE_CAP - 1)
          .exec();
      } catch (err) {
        process.stderr.write(`deepmarks.js: kind:1 enqueue failed ${err.message}\n`);
      }
    }
    respond(event.id, 'shadowReject');
    return;
  }

  const kindAllowed =
    ALLOWED_KINDS.has(event.kind) ||
    (fromTeam && TEAM_EXTENDED_KINDS.has(event.kind));
  if (!kindAllowed) {
    respond(event.id, 'reject', `kind ${event.kind} not accepted on this relay`);
    return;
  }

  // Kind 1985 (NIP-32 labels) is only authoritative when the admin/
  // operational signer produced it. Reject everyone else's so the relay doesn't carry
  // forgeable "lifetime member" labels for arbitrary pubkeys.
  if (event.kind === 1985 && pubkeyLc !== ADMIN_PUBKEY) {
    respond(event.id, 'reject', 'kind 1985 restricted to admin pubkey');
    return;
  }

  // Registered-user gate. Team pubkeys (admin + public brand) always
  // pass. Everyone else has to be in the registry set populated by
  // payment-proxy. NIP-46 (24133) bypasses the gate because the
  // bunker plumbing uses ephemeral session keys that don't go
  // through the registration flow.
  if (!fromTeam && event.kind !== 24133) {
    const registered = await isRegistered(pubkeyLc);
    if (!registered) {
      respond(event.id, 'reject', 'pubkey not registered with deepmarks — sign in at https://deepmarks.org first');
      return;
    }
  }

  // Per-pubkey rate limit — applies to all kinds. NIP-46 (24133) is
  // included intentionally: a runaway client should hit a wall before
  // exhausting Box C's CPU.
  const eventRateLimit = rateLimitForEvent(event);
  if (!rateLimitOk(event.pubkey, eventRateLimit.limit, eventRateLimit.scope)) {
    respond(event.id, 'reject', `rate limit (${eventRateLimit.limit}/hour per pubkey)`);
    return;
  }

  respond(event.id, 'accept');
});
