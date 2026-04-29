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
//   1985   NIP-32 lifetime-member labels (brand-signed durability layer)
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
//   - Kind 1985 is gated to the brand pubkey only. Anyone can publish
//     a NIP-32 label on Nostr generally, but the UI only treats
//     brand-signed lifetime labels as authoritative — letting them
//     pile up here is just relay bloat / impersonation footgun.
//   - Per-pubkey events/hour cap. In-memory map lives for the plugin
//     process lifetime; resets on strfry restart. Stops a single noisy
//     pubkey from filling the LMDB volume.

'use strict';

// Kinds anyone may publish on this relay.
const ALLOWED_KINDS = new Set([39701, 30003, 9735, 1985, 24133]);

// Extra kinds the brand + personal pubkeys may publish — lets either
// of the operator's identities run a Nostr presence on this relay
// (announcements, replies, reposts, reactions, profile, relay list,
// optional long-form) without opening those kinds to the general
// public. In practice the brand pubkey is the one that actually
// posts socially; personal (Dan) is reserved for operational signing,
// but is included in the extended set so a future change of heart
// doesn't need a relay redeploy. Anyone else publishing these kinds
// is still rejected — the relay stays narrowly scoped for non-team
// pubkeys.
const TEAM_EXTENDED_KINDS = new Set([
  0,      // NIP-01 profile metadata (name, about, picture, lud16)
  1,      // NIP-01 text notes (announcements + replies)
  3,      // NIP-02 contact list (who the team follows)
  6,      // NIP-18 reposts (amplify community bookmarks)
  7,      // NIP-25 reactions (likes / emoji)
  10002,  // NIP-65 relay list metadata
  30023,  // NIP-23 long-form articles (release notes, postmortems)
]);

const BRAND_PUBKEY = (process.env.DEEPMARKS_BRAND_PUBKEY ?? '').toLowerCase();
const PERSONAL_PUBKEY = (process.env.DEEPMARKS_PERSONAL_PUBKEY ?? '').toLowerCase();
const TEAM_PUBKEYS = new Set([BRAND_PUBKEY, PERSONAL_PUBKEY].filter(Boolean));
const RATE_LIMIT_PER_HOUR = Number.parseInt(
  process.env.STRFRY_RATE_LIMIT_PER_HOUR ?? '200',
  10,
);
const RATE_WINDOW_MS = 60 * 60 * 1000;

if (!BRAND_PUBKEY) {
  // Without the brand pubkey we can't enforce the kind:1985 gate.
  // Refuse to start so the operator notices instead of silently
  // accepting forged labels from anyone.
  process.stderr.write(
    'deepmarks.js: DEEPMARKS_BRAND_PUBKEY is unset — refusing to start writePolicy\n',
  );
  process.exit(1);
}
if (!PERSONAL_PUBKEY) {
  // Soft-warn: the personal extension is optional. Brand still works.
  process.stderr.write(
    'deepmarks.js: DEEPMARKS_PERSONAL_PUBKEY is unset — only brand pubkey gets extended-kind privileges\n',
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
  //   2. TEAM_EXTENDED_KINDS — only when the publisher is the brand or
  //      personal pubkey. Lets either team identity run a Nostr presence
  //      on its own relay without opening kind:1 etc. to the general
  //      public. In practice the brand pubkey is the one that posts
  //      socially; personal stays operational. Both are allowlisted
  //      here for symmetry.
  const fromTeam = TEAM_PUBKEYS.has(event.pubkey.toLowerCase());
  const kindAllowed =
    ALLOWED_KINDS.has(event.kind) ||
    (fromTeam && TEAM_EXTENDED_KINDS.has(event.kind));
  if (!kindAllowed) {
    respond(event.id, 'reject', `kind ${event.kind} not accepted on this relay`);
    return;
  }

  // Kind 1985 (NIP-32 labels) is only authoritative when the brand
  // signed it. Reject everyone else's so the relay doesn't carry
  // forgeable "lifetime member" labels for arbitrary pubkeys.
  if (event.kind === 1985 && event.pubkey.toLowerCase() !== BRAND_PUBKEY) {
    respond(event.id, 'reject', 'kind 1985 restricted to brand pubkey');
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
