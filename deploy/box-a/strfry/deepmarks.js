#!/usr/bin/env node
// strfry writePolicy plugin — accepts only the kinds Deepmarks actually
// uses this relay to carry. Anything else is rejected to keep the relay
// narrowly scoped (it's not a general-purpose public relay).
//
//   39701  NIP-B0 public web bookmarks (the headline event kind)
//   30003  NIP-51 private bookmark sets (encrypted-to-self via NIP-44 v2 —
//          our relay needs to accept these so the extension and web app
//          can use us as their canonical private-sync relay too, not just
//          for public bookmarks. Content is opaque ciphertext to us.)
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

// Kinds anyone may publish on this relay.
const ALLOWED_KINDS = new Set([39701, 30003, 9735, 1985, 24133]);

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
const TEAM_PUBKEYS = new Set([PUBLIC_BRAND_PUBKEY].filter(Boolean));
const RATE_LIMIT_PER_HOUR = Number.parseInt(
  process.env.STRFRY_RATE_LIMIT_PER_HOUR ?? '200',
  10,
);
const RATE_WINDOW_MS = 60 * 60 * 1000;

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
/** pubkey → { count, windowStart }. Sliding hour-long bucket. */
const buckets = new Map();

function rateLimitOk(pubkey) {
  const now = Date.now();
  let b = buckets.get(pubkey);
  if (!b || now - b.windowStart > RATE_WINDOW_MS) {
    b = { count: 0, windowStart: now };
    buckets.set(pubkey, b);
  }
  b.count += 1;
  return b.count <= RATE_LIMIT_PER_HOUR;
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

rl.on('line', (line) => {
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
  //   1. ALLOWED_KINDS — open to any publisher (the project's headline
  //      kinds + the bunker plumbing).
  //   2. TEAM_EXTENDED_KINDS — only when the publisher is a known
  //      Deepmarks team key. The public brand/social key is the expected
  //      publisher for kind:0/1/3/6/7/10002/30023.
  const fromTeam = TEAM_PUBKEYS.has(event.pubkey.toLowerCase());
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
  if (event.kind === 1985 && event.pubkey.toLowerCase() !== ADMIN_PUBKEY) {
    respond(event.id, 'reject', 'kind 1985 restricted to admin pubkey');
    return;
  }

  // Per-pubkey rate limit — applies to all kinds. NIP-46 (24133) is
  // included intentionally: a runaway client should hit a wall before
  // exhausting Box C's CPU.
  if (!rateLimitOk(event.pubkey)) {
    respond(event.id, 'reject', `rate limit (${RATE_LIMIT_PER_HOUR}/hour per pubkey)`);
    return;
  }

  respond(event.id, 'accept');
});
