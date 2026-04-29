// Permission matrix — hardcoded on purpose. Changing what a client can
// sign on behalf of which identity is a code change, not an env flip, so
// it goes through code review. If payment-proxy is ever compromised, the
// attacker can only sign kinds listed here — NEVER kind:1 (notes),
// kind:0 (profile), kind:3 (contacts), kind:5 (deletions), kind:10002
// (relay list) or anything else.

/** Identity roles the bunker manages. */
export type IdentityName = 'brand' | 'personal';

/** Kinds allowed per identity, for requests from an authorized client.
 *
 *  These are the kinds the BUNKER will sign on behalf of an identity.
 *  Different from what the relay accepts FROM that identity — the brand
 *  nsec is also held by the operator on social clients (Damus, Amethyst,
 *  etc.) where signing happens locally without touching this bunker.
 *  The bunker only handles the operational signing path that
 *  payment-proxy initiates over NIP-46. Anything Dan posts socially
 *  goes through his client's own signer and never asks us. */
const ALLOWED_KINDS: Record<IdentityName, ReadonlySet<number>> = {
  // Brand signs (via this bunker, from payment-proxy):
  //   9735  zap receipts for zap@deepmarks.org
  //   1985  lifetime labels on settlement of the lifetime upgrade
  //   39701 public web bookmarks (Pinboard seeder, etc.)
  // Social kinds (0/1/3/6/7/10002/30023) are deliberately NOT in this
  // list — those are signed directly from Dan's social-client copy of
  // the brand nsec. Keeping the operational signing surface narrow
  // means a payment-proxy compromise can't post fake brand
  // announcements; it can only forge zap receipts and bookmark events,
  // both of which are bounded blast radius (replaceable, kind-narrow).
  brand: new Set([9735, 1985, 39701]),
  // Personal is the operator's admin signing key (Dan). Strictly
  // operational — no social interaction on Nostr, just signing the
  // events the server emits on settlement. Restricting to kind:9735
  // limits the blast radius if Box A is ever compromised: an attacker
  // can forge zap receipts for dan@deepmarks.org but cannot rewrite
  // the operator's profile or post on their behalf.
  personal: new Set([9735]),
};

export interface PermissionCheckContext {
  /** Authorized client pubkey (the payment-proxy instance). */
  authorizedClient: string;
}

export interface PermissionRequest {
  /** Pubkey that sent the NIP-46 request. */
  clientPubkey: string;
  identity: IdentityName;
  /** Kind of the event we're being asked to sign. */
  kind: number;
}

export type PermissionResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Decide whether to honor a sign request. Keep this pure + total so
 * tests can exercise every reject path without needing a running bunker.
 */
export function checkPermission(
  ctx: PermissionCheckContext,
  req: PermissionRequest,
): PermissionResult {
  if (req.clientPubkey !== ctx.authorizedClient) {
    return { ok: false, reason: 'unknown client pubkey' };
  }
  const allowed = ALLOWED_KINDS[req.identity];
  if (!allowed) {
    return { ok: false, reason: `unknown identity: ${req.identity}` };
  }
  if (!allowed.has(req.kind)) {
    return { ok: false, reason: `kind ${req.kind} not allowed for ${req.identity}` };
  }
  return { ok: true };
}

/** Exposed for tests + audit log consumers. */
export function allowedKindsFor(identity: IdentityName): ReadonlySet<number> {
  return ALLOWED_KINDS[identity];
}
