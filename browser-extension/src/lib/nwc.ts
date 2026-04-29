// NIP-47 Nostr Wallet Connect client — pay_invoice round-trip.
//
// The connection (relay + walletPubkey + appSecret) lives in
// nwc-store. This module signs + sends the request and waits for
// the response on a single short-lived subscription.
//
// Request: kind:23194, content = NIP-04 encrypted JSON
//   { "method": "pay_invoice", "params": { "invoice": "lnbc…" } }
//   tags: [["p", walletPubkey]]
//   signed with appSecret (NOT the user's main nsec — NWC channels
//   are isolated per-app per-wallet by design).
//
// Response: kind:23195, content = NIP-04 encrypted JSON
//   { "result_type": "pay_invoice", "result": { "preimage": "…" } }
//   or { "result_type": "pay_invoice", "error": { "code": "…", "message": "…" } }
//   tags: [["e", requestEventId], ["p", appPubkey]]
//
// Errors get surfaced as exceptions with the wallet's reason code in
// the message — some wallets return "INSUFFICIENT_BALANCE",
// "RATE_LIMITED", or "QUOTA_EXCEEDED" which the UI can render verbatim.

import { finalizeEvent, getPublicKey, nip04, SimplePool, type Event as NostrEvent } from 'nostr-tools';
import { hexToBytes, bytesToHex } from 'nostr-tools/utils';
import { sha256 } from '@noble/hashes/sha256';
import { decode as decodeBolt11 } from 'light-bolt11-decoder';
import { loadNwc, type NwcConnection } from './nwc-store.js';

const KIND_NWC_REQUEST = 23194;
const KIND_NWC_RESPONSE = 23195;
/** Wallets typically respond in <2s; cap at 30s so a stuck wallet
 *  doesn't hang the UI forever. */
const RESPONSE_TIMEOUT_MS = 30_000;

export interface PayInvoiceResult {
  preimage: string;
}

export class NwcError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'NwcError';
  }
}

/** Pull the payment_hash hex out of a BOLT-11 invoice. Returns null
 *  on a malformed invoice — caller decides how to handle (current
 *  policy: accept the wallet's preimage on faith if we can't decode). */
function extractPaymentHash(invoice: string): string | null {
  try {
    const decoded = decodeBolt11(invoice) as { sections?: Array<{ name?: string; value?: string }> };
    const section = decoded.sections?.find((s) => s.name === 'payment_hash');
    const value = section?.value;
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) return null;
    return value;
  } catch {
    return null;
  }
}

export async function isNwcConnected(): Promise<boolean> {
  const conn = await loadNwc();
  return !!conn;
}

/**
 * Pay a BOLT-11 invoice through the connected NWC wallet. Throws
 * NwcError with the wallet's `code` (e.g. INSUFFICIENT_BALANCE) on
 * wallet-side failure, or a generic Error on transport / timeout
 * issues. Callers should display the message verbatim — wallets
 * already write user-friendly reasons.
 */
export async function payInvoice(invoice: string): Promise<PayInvoiceResult> {
  const conn = await loadNwc();
  if (!conn) throw new Error('no NWC wallet connected — open Settings to paste a connection URI');
  return payInvoiceWith(conn, invoice);
}

/** Pay with an explicit connection — used by the test-connection flow
 *  in Settings before the connection is persisted. */
export async function payInvoiceWith(
  conn: NwcConnection,
  invoice: string,
): Promise<PayInvoiceResult> {
  const appSecretBytes = hexToBytes(conn.appSecret);
  const appPubkey = getPublicKey(appSecretBytes);

  const payload = JSON.stringify({
    method: 'pay_invoice',
    params: { invoice },
  });
  const encryptedContent = await nip04.encrypt(appSecretBytes, conn.walletPubkey, payload);

  const event = finalizeEvent(
    {
      kind: KIND_NWC_REQUEST,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', conn.walletPubkey]],
      content: encryptedContent,
    },
    appSecretBytes,
  );

  // SimplePool isn't reused here — the NWC channel is single-relay
  // and short-lived per request. Cleanup is done in the finally
  // block so a thrown await doesn't leak a subscription.
  const pool = new SimplePool();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const responsePromise = new Promise<NostrEvent>((resolve, reject) => {
      const sub = pool.subscribeMany(
        [conn.relayUrl],
        {
          kinds: [KIND_NWC_RESPONSE],
          authors: [conn.walletPubkey],
          '#e': [event.id],
          '#p': [appPubkey],
          // since: a few seconds before now to forgive clock skew.
          since: Math.floor(Date.now() / 1000) - 10,
        },
        {
          onevent: (ev: NostrEvent) => {
            sub.close();
            resolve(ev);
          },
          oneose: () => { /* keep listening past EOSE — response may arrive later */ },
        },
      );

      timeoutId = setTimeout(() => {
        sub.close();
        reject(new Error(`NWC wallet did not respond within ${RESPONSE_TIMEOUT_MS / 1000}s`));
      }, RESPONSE_TIMEOUT_MS);
    });

    // Publish the request to the wallet's relay. Some relays return
    // an OK ack synchronously; some don't — we don't gate on it.
    await Promise.allSettled(pool.publish([conn.relayUrl], event));

    const responseEvent = await responsePromise;
    const decrypted = await nip04.decrypt(
      appSecretBytes,
      conn.walletPubkey,
      responseEvent.content,
    );
    let parsed: { result_type?: string; error?: { code?: string; message?: string }; result?: { preimage?: string } };
    try {
      parsed = JSON.parse(decrypted);
    } catch {
      throw new Error('NWC wallet returned malformed response');
    }
    if (parsed.error) {
      throw new NwcError(
        parsed.error.code ?? 'UNKNOWN',
        parsed.error.message ?? 'wallet declined the payment',
      );
    }
    const preimage = parsed.result?.preimage;
    if (!preimage || typeof preimage !== 'string' || !/^[0-9a-f]{64}$/i.test(preimage)) {
      throw new Error('NWC wallet returned invalid preimage');
    }
    // Verify the preimage actually corresponds to the invoice we asked
    // them to pay. NIP-47 doesn't mandate this client-side — and many
    // implementations skip it — but a malicious wallet could otherwise
    // return any 32 random bytes and we'd treat the payment as
    // confirmed. sha256(preimage) MUST equal the invoice's payment_hash.
    const expectedHash = extractPaymentHash(invoice);
    if (expectedHash) {
      const actualHash = bytesToHex(sha256(hexToBytes(preimage.toLowerCase())));
      if (actualHash !== expectedHash.toLowerCase()) {
        throw new NwcError(
          'BAD_PREIMAGE',
          `wallet returned a preimage that does not hash to the invoice's payment_hash`,
        );
      }
    }
    // If we couldn't decode the invoice (malformed prefix etc) we
    // accept the preimage on faith — better than blocking a probably-
    // valid payment, and the wallet was the one who decoded the
    // invoice to begin with.
    return { preimage };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    pool.close([conn.relayUrl]);
  }
}
