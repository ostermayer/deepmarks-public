import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * LUD-06 metadata JSON (returned inside the top-level `metadata` field
 * as a stringified array of [type, value] pairs).
 */
export function buildLud06Metadata(lnAddress: string): string {
  return JSON.stringify([
    ['text/plain', 'Zap Deepmarks — bookmarks for the open web'],
    ['text/identifier', lnAddress],
  ]);
}

/**
 * LNURL-pay response for GET /.well-known/lnurlp/<username>
 * Conforms to LUD-06 + LUD-16 + NIP-57 extensions.
 */
export interface LnurlpResponse {
  callback: string;
  maxSendable: number;
  minSendable: number;
  metadata: string;
  tag: 'payRequest';
  /** NIP-57: declares support for zap requests. */
  allowsNostr: true;
  /** NIP-57: the pubkey that will sign kind:9735 receipts. */
  nostrPubkey: string;
  /** LUD-12: allow a short comment (used when no nostr zap request present). */
  commentAllowed: number;
}

export function buildLnurlpResponse(opts: {
  callbackUrl: string;
  lnAddress: string;
  nostrPubkey: string;
  minSendableMsat?: number;
  maxSendableMsat?: number;
}): LnurlpResponse {
  return {
    callback: opts.callbackUrl,
    minSendable: opts.minSendableMsat ?? 1_000,                // 1 sat
    // Cap at 1M sats (~$600 at $60k/BTC) per single invoice. The 100M
    // ceiling LUDs allow is unrealistic for our use case (zaps + tipjar)
    // and lets an attacker reserve disproportionate channel capacity
    // by spamming huge invoices. Real users hit this with a separate
    // "send larger amount?" UX in their wallet.
    maxSendable: opts.maxSendableMsat ?? 1_000_000_000,        // 1M sats
    metadata: buildLud06Metadata(opts.lnAddress),
    tag: 'payRequest',
    allowsNostr: true,
    nostrPubkey: opts.nostrPubkey,
    commentAllowed: 280,
  };
}

/**
 * Compute the description hash that goes into the BOLT-11 invoice.
 *
 * For NIP-57 zaps: SHA-256 of the *exact raw JSON string* of the zap request.
 *   (Not a re-serialized form — the string as received.)
 * For plain LUD-06 lnurl-pays: SHA-256 of the metadata JSON string.
 */
export function descriptionHashHex(rawInput: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(rawInput)));
}

/**
 * The shape we return from the callback endpoint.
 * Per LUD-06, we return `pr` (BOLT-11) and `routes: []`.
 */
export interface LnurlpCallbackResponse {
  pr: string;
  routes: never[];
}

export function buildCallbackResponse(invoice: string): LnurlpCallbackResponse {
  return { pr: invoice, routes: [] };
}

/**
 * A LUD-06-compliant error response.
 */
export function lnurlError(reason: string): { status: 'ERROR'; reason: string } {
  return { status: 'ERROR', reason };
}
