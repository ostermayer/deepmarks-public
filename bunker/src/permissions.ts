// Permission matrix — hardcoded on purpose. Changing what a client can
// sign on behalf of which identity is a code change, not an env flip, so
// it goes through code review. If api is ever compromised, the
// attacker can only sign kinds listed here — never profile/contact/
// deletion/relay-list events or anything else.

/** Legacy identity role names the bunker manages.
 *
 *  `brand` is the admin/operational signer role, not the public
 *  brand/social npub used on Damus and in NIP-89 coordinates. In
 *  production, `personal` is currently the public profile/social key
 *  (`npub199z...`); the role name remains for deploy compatibility. */
export type IdentityName = 'brand' | 'personal';

/** Kinds allowed per identity, for requests from an authorized client.
 *
 *  These are the kinds the BUNKER will sign on behalf of an identity.
 *  Different from what the relay accepts FROM that identity — the brand
 *  nsec is also held by the operator on social clients (Damus, Amethyst,
 *  etc.) where signing happens locally without touching this bunker.
 *  The bunker only handles the operational signing path that
 *  api initiates over NIP-46. Anything Dan posts socially
 *  goes through his client's own signer and never asks us. */
const ALLOWED_KINDS: Record<IdentityName, ReadonlySet<number>> = {
  // Legacy "brand" role signs (via this bunker, from api):
  //   9735  zap receipts for zap@deepmarks.org
  //   1985  lifetime labels on settlement of the lifetime upgrade
  //   39701 public web bookmarks (legacy Pinboard seeder, etc.)
  // Social kinds are deliberately NOT in this admin/operational list.
  // Keeping the operational signing surface narrow means a api
  // compromise can't post fake announcements from the admin key.
  brand: new Set([9735, 1985, 39701]),
  // Production maps this legacy role to the public brand/social profile
  // key. The server can sign:
  //   9735  zap receipts for the mapped LNURL identity
  //   39701 one daily Pinboard bookmark
  //   1     the matching social cross-post
  // It still cannot rewrite the profile, contacts, relay list, or
  // publish deletions/reposts/reactions.
  personal: new Set([9735, 39701, 1]),
};

export interface PermissionCheckContext {
  /** Authorized client pubkey (the api instance). */
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
