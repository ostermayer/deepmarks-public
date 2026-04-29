import { verifyEvent, SimplePool, type EventTemplate, type Event as NostrEvent, type Filter } from 'nostr-tools';
import type { PendingZap, ZapRequestEvent } from './types.js';
import type { RemoteSigner } from './signer.js';

// ─── Zap request validation (NIP-57 Appendix D) ───────────────────────

/**
 * Validate an incoming zap request per NIP-57 Appendix D.
 * Throws on any violation — caller should 400 the LNURL callback.
 *
 * @param event       the parsed zap request JSON
 * @param amountMsat  the amount query param on the callback (millisats)
 */
export function validateZapRequest(event: unknown, amountMsat: number): ZapRequestEvent {
  if (!event || typeof event !== 'object') {
    throw new ZapValidationError('not an object');
  }
  const e = event as ZapRequestEvent;

  if (e.kind !== 9734) throw new ZapValidationError(`kind must be 9734, got ${e.kind}`);
  if (typeof e.sig !== 'string' || e.sig.length !== 128) {
    throw new ZapValidationError('missing or invalid sig');
  }
  if (typeof e.pubkey !== 'string' || e.pubkey.length !== 64) {
    throw new ZapValidationError('missing or invalid pubkey');
  }
  if (!Array.isArray(e.tags)) throw new ZapValidationError('missing tags');

  // Signature check
  if (!verifyEvent(e as NostrEvent)) {
    throw new ZapValidationError('signature does not verify');
  }

  // Exactly one p tag (recipient)
  const pTags = e.tags.filter((t) => t[0] === 'p');
  if (pTags.length !== 1) throw new ZapValidationError('must have exactly one p tag');
  if (!/^[0-9a-f]{64}$/.test(pTags[0][1] ?? '')) {
    throw new ZapValidationError('p tag is not a valid pubkey');
  }

  // 0 or 1 e tags
  const eTags = e.tags.filter((t) => t[0] === 'e');
  if (eTags.length > 1) throw new ZapValidationError('at most one e tag allowed');

  // 0 or 1 a tags
  const aTags = e.tags.filter((t) => t[0] === 'a');
  if (aTags.length > 1) throw new ZapValidationError('at most one a tag allowed');

  // 0 or 1 P tags
  const senderPTags = e.tags.filter((t) => t[0] === 'P');
  if (senderPTags.length > 1) throw new ZapValidationError('at most one P tag allowed');

  // Amount tag, if present, must match callback amount
  const amountTag = e.tags.find((t) => t[0] === 'amount');
  if (amountTag) {
    const declared = Number.parseInt(amountTag[1] ?? '', 10);
    if (!Number.isFinite(declared) || declared !== amountMsat) {
      throw new ZapValidationError(`amount tag (${declared}) does not match callback amount (${amountMsat})`);
    }
  }

  // relays tag should be present for us to know where to publish
  const relaysTag = e.tags.find((t) => t[0] === 'relays');
  if (!relaysTag || relaysTag.length < 2) {
    throw new ZapValidationError('relays tag is required so we know where to publish the receipt');
  }

  return e;
}

export class ZapValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ZapValidationError';
  }
}

// ─── Zap receipt construction and publishing (NIP-57 Appendix E) ──────

/**
 * Build + sign a kind:9735 zap receipt event from a settled zap invoice.
 *
 * Rules enforced:
 *   - content is empty
 *   - created_at = invoice paid_at (seconds)
 *   - includes bolt11 and description tags
 *   - p / e / a / P copied forward from the zap request
 *   - signed by the given signer (whose pubkey must match the one
 *     advertised as nostrPubkey in the LNURL metadata that produced
 *     this pending zap)
 */
export async function buildZapReceipt(
  pending: PendingZap,
  paidAt: number,
  preimage: string | undefined,
  signer: RemoteSigner,
): Promise<NostrEvent> {
  const zr = pending.zapRequest;
  const recipient = firstTagValue(zr.tags, 'p');
  // Defence in depth: the invoice handler picks the signer by recipient
  // pubkey before calling us, but if that selection ever drifts (a
  // typo, a future signer added without updating signerForRecipient)
  // we'd silently issue a kind:9735 from the wrong identity attesting
  // payment to a third party. Fail loud here so the bug shows up in
  // logs instead of producing fraudulent receipts.
  if (!recipient) throw new Error('zap request has no recipient p tag');
  if (recipient !== signer.pubkey) {
    throw new Error(`zap signer ${signer.pubkey.slice(0, 12)}… does not match recipient ${recipient.slice(0, 12)}…`);
  }

  const receiptTags: string[][] = [
    ['p', recipient],
    ['bolt11', pending.invoice],
    ['description', pending.rawZapRequest],
  ];

  const eTag = firstTagValue(zr.tags, 'e');
  if (eTag) receiptTags.push(['e', eTag]);

  const aTag = firstTagValue(zr.tags, 'a');
  if (aTag) receiptTags.push(['a', aTag]);

  // sender pubkey — either explicit P tag or the zap request's pubkey field
  const senderP = firstTagValue(zr.tags, 'P') ?? zr.pubkey;
  if (senderP) receiptTags.push(['P', senderP]);

  if (preimage) receiptTags.push(['preimage', preimage]);

  const template: EventTemplate = {
    kind: 9735,
    created_at: paidAt,
    content: '',
    tags: receiptTags,
  };

  return signer.sign(template);
}

function firstTagValue(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

/**
 * Publish a signed zap receipt to the relays specified in the zap request,
 * with a sensible timeout and best-effort delivery.
 */
export async function publishZapReceipt(
  event: NostrEvent,
  relays: string[],
  pool: SimplePool,
  timeoutMs = 5000,
): Promise<{ ok: string[]; failed: string[] }> {
  const ok: string[] = [];
  const failed: string[] = [];

  const publishes = pool.publish(relays, event);
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));

  await Promise.race([
    Promise.allSettled(publishes).then((results) => {
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') ok.push(relays[i]);
        else failed.push(relays[i]);
      });
    }),
    timeout,
  ]);

  return { ok, failed };
}

export function createRelayPool(): SimplePool {
  return new SimplePool();
}

// ─── NIP-32 lifetime-member labels ────────────────────────────────────
//
// Durability layer #2: on every settled lifetime invoice we publish a
// kind:1985 label event from the Deepmarks brand pubkey attesting that
// the buyer's pubkey is a lifetime member. The label is machine-readable
// (does NOT appear in Damus/Primal feeds — kind 1985 is not a social
// post) and survives on our relay + the public ones as a second source
// of truth alongside BTCPay. If Redis is ever wiped, we re-populate
// from either BTCPay (primary) or these relay events (backup).
//
// NIP-32 structure:
//   ["L", "<namespace>"]               — label namespace
//   ["l", "<value>", "<namespace>"]    — label value within namespace
//   ["p", "<pubkey>"]                  — entity being labeled
//   ...additional tags are allowed and the value is embedded in tags,
//       so content can safely be a human-readable blurb.

export const LIFETIME_LABEL_NAMESPACE = 'org.deepmarks.tier';
export const LIFETIME_LABEL_VALUE = 'lifetime';

export interface LifetimeLabelInput {
  /** The member's hex pubkey — subject of the attestation. */
  memberPubkey: string;
  /** Unix seconds when the settlement landed. */
  paidAt: number;
  /** Optional BTCPay invoice id, attached for cross-referencing. */
  invoiceId?: string;
}

/**
 * Build + sign a kind:1985 lifetime-member label event. Signing is remote
 * (via the bunker) so this is async even though the template shape is
 * deterministic.
 */
export async function buildLifetimeLabel(
  signer: RemoteSigner,
  input: LifetimeLabelInput,
): Promise<NostrEvent> {
  const tags: string[][] = [
    ['L', LIFETIME_LABEL_NAMESPACE],
    ['l', LIFETIME_LABEL_VALUE, LIFETIME_LABEL_NAMESPACE],
    ['p', input.memberPubkey],
    ['paid_at', String(input.paidAt)],
  ];
  if (input.invoiceId) tags.push(['invoice_id', input.invoiceId]);

  const template: EventTemplate = {
    kind: 1985,
    created_at: input.paidAt,
    tags,
    content: 'Deepmarks lifetime membership',
  };
  return signer.sign(template);
}

/**
 * Publish the label to the configured relay set with a best-effort timeout.
 * Returns which relays accepted vs failed so callers can log the fanout.
 */
export async function publishLifetimeLabel(
  signer: RemoteSigner,
  input: LifetimeLabelInput,
  relays: string[],
  pool: SimplePool,
  timeoutMs = 5000,
): Promise<{ event: NostrEvent; ok: string[]; failed: string[] }> {
  const event = await buildLifetimeLabel(signer, input);
  const ok: string[] = [];
  const failed: string[] = [];
  const publishes = pool.publish(relays, event);
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([
    Promise.allSettled(publishes).then((results) => {
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') ok.push(relays[i]);
        else failed.push(relays[i]);
      });
    }),
    timeout,
  ]);
  return { event, ok, failed };
}

/**
 * Query relays for every lifetime label we've ever published under the
 * given author pubkey. Used at boot time to rehydrate Redis if it was
 * wiped. Read-only — no signer needed.
 */
export async function queryLifetimeLabels(
  authorPubkey: string,
  relays: string[],
  pool: SimplePool,
  timeoutMs = 8000,
): Promise<Array<{ memberPubkey: string; paidAt: number }>> {
  const events = await new Promise<NostrEvent[]>((resolve) => {
    const collected: NostrEvent[] = [];
    const filter: Filter = {
      kinds: [1985],
      authors: [authorPubkey],
      '#L': [LIFETIME_LABEL_NAMESPACE],
    };
    // nostr-tools v2 `subscribeMany` takes a single Filter per relay set.
    const sub = pool.subscribeMany(
      relays,
      filter,
      {
        onevent(e: NostrEvent) { collected.push(e); },
        oneose() { resolve(collected); sub.close(); },
      },
    );
    setTimeout(() => { resolve(collected); sub.close(); }, timeoutMs);
  });

  const byPubkey = new Map<string, number>();
  for (const e of events) {
    // Author filter is server-side on relays we don't fully control; a
    // hostile relay can return events with a forged `pubkey` matching
    // our brand. Re-verify the signature locally before trusting any of
    // these to grant lifetime tier (free archives, API keys, short
    // usernames) to arbitrary pubkeys at boot.
    if (!verifyEvent(e)) continue;
    if (e.pubkey !== authorPubkey) continue;
    const memberPubkey = e.tags.find((t) => t[0] === 'p')?.[1];
    if (!memberPubkey || !/^[0-9a-f]{64}$/i.test(memberPubkey)) continue;
    const paidRaw = e.tags.find((t) => t[0] === 'paid_at')?.[1];
    const paidAt = paidRaw ? Number.parseInt(paidRaw, 10) : e.created_at;
    if (!Number.isFinite(paidAt)) continue;
    const prev = byPubkey.get(memberPubkey);
    if (prev === undefined || paidAt < prev) byPubkey.set(memberPubkey, paidAt);
  }
  return Array.from(byPubkey.entries()).map(([memberPubkey, paidAt]) => ({ memberPubkey, paidAt }));
}
