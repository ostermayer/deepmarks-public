// Core NIP-46 request handler. Pure function of (incoming event, deps)
// → signed response event or null. Split out from index.ts so tests can
// exercise the entire decrypt → permission-check → sign → encrypt pipeline
// without needing a relay.

import { finalizeEvent, type Event as NostrEvent } from 'nostr-tools';
import { AuditLog } from './audit.js';
import {
  NIP46_KIND,
  buildError,
  buildResult,
  decryptPayload,
  deriveKey,
  encodeResponse,
  encryptPayload,
  parseRequest,
  parseSignEventParam,
  serializeSignedEvent,
} from './nip46.js';
import { checkPermission, type IdentityName } from './permissions.js';
import { Vault } from './vault.js';

export interface HandlerDeps {
  vault: Vault;
  audit: AuditLog;
  /** The single pubkey allowed to request signatures. */
  authorizedClient: string;
}

/**
 * Process one incoming NIP-46 event. Returns a signed kind:24133 event
 * to publish back, or null if the event is not addressed to us / is
 * undecodable / isn't worth responding to.
 *
 * Never throws — any unexpected error is audited with outcome='errored'
 * and swallowed. The whole point of this service is to be boring.
 */
// Unauthorized-flood audit throttle. strfry exempts kind:24133 from its
// write policy, so any internet pubkey can make the relay deliver junk
// here — and auditing EVERY rejection with a synchronous appendFileSync
// let a rotating-pubkey flood drive attacker-sized disk writes on the
// same disk the signer uses (2026-08-23 review). Keep the security
// signal, bound the writes: one aggregated entry per window.
const UNAUTHORIZED_AUDIT_WINDOW_MS = 10_000;
let unauthorizedWindowStartMs = 0;
let unauthorizedSuppressed = 0;

// Replay guard: the relay stores kind:24133, and every (re)subscribe
// replays recent stored events — without dedup the bunker re-signed the
// authorized client's recent requests on each reconnect (2026-08-23
// review). Bounded id set; pairs with the `since` on the subscription.
const SEEN_REQUEST_EVENT_IDS = new Set<string>();
const SEEN_REQUEST_EVENT_CAP = 512;

// Envelope freshness: the seen-id set is process-local, so a captured
// request event re-POSTed to strfry after a bunker restart would still
// be re-signed. The request ENVELOPE's created_at must be recent — the
// authorized client is Box A's api (NTP-synced), so 10 minutes is
// generous. Rejections are audit-throttled like the unauthorized gate:
// replayed captures carry the AUTHORIZED pubkey, so a flood of them
// would otherwise drive unbounded audit writes too.
const REQUEST_MAX_AGE_SECONDS = 10 * 60;
const REQUEST_MAX_FUTURE_SKEW_SECONDS = 10 * 60;
let staleWindowStartMs = 0;
let staleSuppressed = 0;

export async function handleRequest(
  deps: HandlerDeps,
  ev: NostrEvent,
): Promise<NostrEvent | null> {
  const identity = identityForEvent(deps.vault, ev);
  if (!identity) return null;

  const clientPubkey = ev.pubkey;
  let requestId = 'unknown';
  let requestKind: number | null = null;

  // Authorization gate BEFORE we derive a conversation key or decrypt.
  // Box A's strfry accepts kind:24133 from any internet pubkey, so an
  // attacker can flood us with junk events and otherwise force a
  // per-event scalar-mult + NIP-44 decrypt cycle on the brand secret.
  // Reject unauthorized pubkeys immediately — cheap O(1) string compare.
  if (clientPubkey !== deps.authorizedClient) {
    const nowMs = Date.now();
    if (nowMs - unauthorizedWindowStartMs >= UNAUTHORIZED_AUDIT_WINDOW_MS) {
      deps.audit.append({
        ts: now(),
        clientPubkey,
        identity,
        kind: null,
        outcome: 'rejected',
        reason: unauthorizedSuppressed > 0
          ? `unauthorized client pubkey (+${unauthorizedSuppressed} more suppressed in the last ${UNAUTHORIZED_AUDIT_WINDOW_MS / 1000}s)`
          : 'unauthorized client pubkey',
      });
      unauthorizedWindowStartMs = nowMs;
      unauthorizedSuppressed = 0;
    } else {
      unauthorizedSuppressed += 1;
    }
    return null;
  }

  // Envelope freshness gate — closes the cross-restart replay window the
  // process-local seen-set cannot (2026-08-23 follow-up).
  const envelopeAge = now() - ev.created_at;
  if (envelopeAge > REQUEST_MAX_AGE_SECONDS || -envelopeAge > REQUEST_MAX_FUTURE_SKEW_SECONDS) {
    const nowMs = Date.now();
    if (nowMs - staleWindowStartMs >= UNAUTHORIZED_AUDIT_WINDOW_MS) {
      deps.audit.append({
        ts: now(),
        clientPubkey,
        identity,
        kind: null,
        outcome: 'rejected',
        reason: staleSuppressed > 0
          ? `stale or future-dated request envelope (+${staleSuppressed} more suppressed in the last ${UNAUTHORIZED_AUDIT_WINDOW_MS / 1000}s)`
          : 'stale or future-dated request envelope',
      });
      staleWindowStartMs = nowMs;
      staleSuppressed = 0;
    } else {
      staleSuppressed += 1;
    }
    return null;
  }

  // Drop replays of requests we already processed (same event id).
  if (SEEN_REQUEST_EVENT_IDS.has(ev.id)) return null;
  SEEN_REQUEST_EVENT_IDS.add(ev.id);
  if (SEEN_REQUEST_EVENT_IDS.size > SEEN_REQUEST_EVENT_CAP) {
    const oldest = SEEN_REQUEST_EVENT_IDS.values().next().value;
    if (oldest !== undefined) SEEN_REQUEST_EVENT_IDS.delete(oldest);
  }

  try {
    const conversationKey = deriveKey(deps.vault.secretFor(identity), clientPubkey);
    const plaintext = decryptPayload(conversationKey, ev.content);
    const req = parseRequest(plaintext);
    requestId = req.id;

    const responsePayload = dispatchMethod(deps, identity, clientPubkey, req);

    if (responsePayload.auditKind !== undefined) requestKind = responsePayload.auditKind;
    deps.audit.append({
      ts: now(),
      clientPubkey,
      identity,
      kind: requestKind,
      outcome: responsePayload.outcome,
      reason: responsePayload.reason,
      eventId: responsePayload.eventId,
    });

    const cipher = encryptPayload(conversationKey, encodeResponse(responsePayload.response));
    return finalizeEvent(
      {
        kind: NIP46_KIND,
        content: cipher,
        tags: [
          ['p', clientPubkey],
          ['e', ev.id],
        ],
        created_at: now(),
      },
      deps.vault.secretFor(identity),
    );
  } catch (err) {
    // Map to a stable allowlist instead of writing the raw exception
    // message. Today's NIP-44 / JSON exceptions don't carry secrets,
    // but a future library wrapping ciphertext bytes (or PII from a
    // sign template) in its message would otherwise leak straight to
    // the on-disk audit log. Audit categories stay coarse enough to
    // be useful for ops without exposing internals.
    deps.audit.append({
      ts: now(),
      clientPubkey,
      identity,
      kind: requestKind,
      outcome: 'errored',
      reason: classifyError(err),
    });
    // Don't respond to malformed / undecodable events. A well-behaved
    // client will time out and retry; a misbehaving one won't learn
    // anything useful from a specific error frame.
    return null;
  }
}

function classifyError(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown_error';
  const msg = err.message.toLowerCase();
  // Order matters: more-specific matches first.
  if (msg.includes('decrypt') || msg.includes('cipher') || msg.includes('mac'))   return 'decrypt_failed';
  if (msg.includes('json') || msg.includes('parse') || msg.includes('unexpected token')) return 'parse_failed';
  if (msg.includes('permission') || msg.includes('not allowed'))                  return 'permission_denied';
  if (msg.includes('sign'))                                                       return 'sign_failed';
  if (msg.includes('vault') || msg.includes('secret'))                            return 'vault_failed';
  return 'unknown_error';
}

interface DispatchOutcome {
  response: ReturnType<typeof buildResult> | ReturnType<typeof buildError>;
  outcome: 'accepted' | 'rejected';
  reason?: string;
  eventId?: string;
  auditKind?: number;
}

function dispatchMethod(
  deps: HandlerDeps,
  identity: IdentityName,
  clientPubkey: string,
  req: { id: string; method: string; params: string[] },
): DispatchOutcome {
  // Every method re-checks the client pubkey against the allowlist.
  const clientAllowed = clientPubkey === deps.authorizedClient;

  switch (req.method) {
    case 'connect': {
      if (!clientAllowed) {
        return {
          response: buildError(req.id, 'unknown client pubkey'),
          outcome: 'rejected',
          reason: 'unknown client pubkey',
        };
      }
      return {
        response: buildResult(req.id, 'ack'),
        outcome: 'accepted',
        reason: 'connect',
      };
    }
    case 'get_public_key': {
      if (!clientAllowed) {
        return {
          response: buildError(req.id, 'unknown client pubkey'),
          outcome: 'rejected',
          reason: 'unknown client pubkey',
        };
      }
      return {
        response: buildResult(req.id, deps.vault.pubkeyFor(identity)),
        outcome: 'accepted',
        reason: 'get_public_key',
      };
    }
    case 'ping': {
      return {
        response: buildResult(req.id, 'pong'),
        outcome: 'accepted',
        reason: 'ping',
      };
    }
    case 'sign_event': {
      if (req.params.length !== 1) {
        return {
          response: buildError(req.id, 'sign_event expects exactly 1 param'),
          outcome: 'rejected',
          reason: 'malformed params',
        };
      }
      const template = parseSignEventParam(req.params[0]);
      const perm = checkPermission(
        { authorizedClient: deps.authorizedClient },
        { clientPubkey, identity, kind: template.kind },
      );
      if (!perm.ok) {
        return {
          response: buildError(req.id, perm.reason),
          outcome: 'rejected',
          reason: perm.reason,
          auditKind: template.kind,
        };
      }
      const signed = deps.vault.sign(identity, template);
      return {
        response: buildResult(req.id, serializeSignedEvent(signed)),
        outcome: 'accepted',
        eventId: signed.id,
        auditKind: template.kind,
      };
    }
    default: {
      return {
        response: buildError(req.id, `unsupported method: ${req.method}`),
        outcome: 'rejected',
        reason: `unsupported method: ${req.method}`,
      };
    }
  }
}

function identityForEvent(vault: Vault, ev: NostrEvent): IdentityName | null {
  const pTag = ev.tags.find((t) => t[0] === 'p');
  if (!pTag || typeof pTag[1] !== 'string') return null;
  for (const e of vault.entries()) {
    if (e.pubkey === pTag[1]) return e.identity;
  }
  return null;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}
