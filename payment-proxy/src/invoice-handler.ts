// Lightning `invoice_updated` subscription handler.
//
// One subscription covers all invoices on the Voltage node (zaps +
// legacy metered archive invoices). We route by payment-hash lookup in Redis. Skipped
// when Voltage isn't configured (dev mode without a node). Returns the
// subscription handle so `index.ts` can shut it down on SIGTERM.

import { subscribeToInvoices } from 'lightning';
import { SubscriptionCircuitBreaker } from './voltage.js';
import { buildZapReceipt, publishZapReceipt } from './nostr.js';
import { settleArchivePurchase } from './purchase-settlement.js';
import type { RemoteSigner } from './signer.js';
import type { Deps } from './route-deps.js';

export interface InvoiceSubHandle {
  removeAllListeners(): void;
}

export function attachInvoiceHandler(deps: Deps): InvoiceSubHandle | null {
  const { app, lnd, zaps, purchases, signers, relayPool, alerter } = deps;
  if (!lnd) return null;

  const invoiceSub = subscribeToInvoices({ lnd });

  /** Pick the signer whose pubkey matches the zap request's recipient
   *  `p` tag. Returns null if the zap was addressed to a pubkey we
   *  don't control — which shouldn't happen because our LNURL callback
   *  only creates pending zaps for our own identities, but defensive. */
  function signerForRecipient(recipientPubkey: string): RemoteSigner | null {
    if (recipientPubkey === signers.brand.pubkey) return signers.brand;
    if (recipientPubkey === signers.personal.pubkey) return signers.personal;
    return null;
  }

  invoiceSub.on('invoice_updated', async (inv: {
    id: string;
    is_confirmed: boolean;
    secret?: string;     // preimage
    mtokens?: string;          // invoiced amount, msats (string to avoid 53-bit loss)
    received_mtokens?: string; // settled amount, msats — must be >= mtokens
  }) => {
    if (!inv.is_confirmed) return;

    // Defence-in-depth: refuse to credit underpaid invoices. LND only marks
    // an invoice `is_confirmed` once it's fully paid for plain BOLT-11, but
    // AMP / hodl-invoice variants and edge cases in newer LND builds can
    // surface partial settlements through this same callback. Without this
    // check, an attacker who finds such a path pays 1 sat against a
    // 21-sat zap invoice and we'd publish a signed receipt for 21.
    if (inv.mtokens && inv.received_mtokens) {
      try {
        const invoiced = BigInt(inv.mtokens);
        const received = BigInt(inv.received_mtokens);
        if (received < invoiced) {
          app.log.warn(
            { paymentHash: inv.id, invoiced: invoiced.toString(), received: received.toString() },
            'invoice underpaid — refusing to credit',
          );
          return;
        }
      } catch {
        app.log.warn({ paymentHash: inv.id }, 'invoice mtokens parse failure — refusing to credit');
        return;
      }
    }

    // 1) Zap?
    try {
      const pending = await zaps.consume(inv.id);
      if (pending) {
        // Defence: a future Redis prefix collision (or stray DEBUG ops)
        // could surface a record under the wrong paymentHash key. The
        // zap record carries the paymentHash it was created for; if it
        // disagrees with the LND-reported invoice id, refuse to sign a
        // receipt that would attest to the wrong payment.
        if (pending.paymentHash !== inv.id) {
          app.log.error(
            { invId: inv.id, recordHash: pending.paymentHash },
            'zap record paymentHash mismatch — refusing to publish receipt',
          );
          return;
        }
        const paidAt = Math.floor(Date.now() / 1000);
        const recipient = pending.zapRequest.tags.find((t) => t[0] === 'p')?.[1];
        const signer = recipient ? signerForRecipient(recipient) : null;
        if (!signer) {
          app.log.error(
            { paymentHash: inv.id, recipient },
            'zap receipt signer not found for recipient pubkey',
          );
          return;
        }
        const receipt = await buildZapReceipt(pending, paidAt, inv.secret, signer);
        const { ok, failed } = await publishZapReceipt(receipt, pending.relays, relayPool);
        app.log.info(
          { paymentHash: inv.id, receiptId: receipt.id, recipient, ok, failed },
          'zap receipt published',
        );
        return; // zap handled; don't fall through
      }
    } catch (err) {
      app.log.error({ err, paymentHash: inv.id }, 'failed to publish zap receipt');
      return;
    }

    // 2) Legacy metered archive invoice?
    try {
      await settleArchivePurchase({
        purchases,
        paymentHash: inv.id,
        log: app.log,
        alerter,
        source: 'voltage',
      });
    } catch (err) {
      app.log.error({ err, paymentHash: inv.id }, 'failed to enqueue archive job');
    }
  });

  // Circuit breaker prevents the subscription's internal reconnect loop
  // from flooding logs (and hammering Voltage) on a persistent misconfig.
  // Any successful invoice_updated event resets the counter, so transient
  // flakes don't accumulate.
  const invoiceBreaker = new SubscriptionCircuitBreaker();
  invoiceSub.on('invoice_updated', () => {
    invoiceBreaker.recordSuccess();
    // Liveness stamp for /admin/dashboard — every invoice_updated tick
    // is proof Voltage is talking to us.
    void deps.redis.set('dm:voltage:last-ok', String(Date.now())).catch(() => undefined);
  });
  invoiceSub.on('error', (err) => {
    const state = invoiceBreaker.recordError();
    if (state === 'silent') return;
    if (state === 'trip') {
      invoiceSub.removeAllListeners();
      app.log.error(
        { err, attempts: invoiceBreaker.errorCount },
        'giving up on voltage invoice subscription after repeated failures — verify VOLTAGE_REST_URL points to the gRPC socket (10009), then restart',
      );
      void alerter.alert({
        severity: 'critical',
        key: 'voltage-circuit-tripped',
        subject: 'voltage invoice subscription circuit breaker tripped — Lightning is OFF',
        body: `The Lightning invoice subscription has failed ${invoiceBreaker.errorCount} times in a row and the circuit breaker tripped. NEW INVOICES STILL WORK (one-shot creation), BUT NO PAYMENTS WILL SETTLE — incoming zaps and any legacy metered archive invoices will sit unconfirmed until this is fixed.\n\nLikely causes:\n  - VOLTAGE_REST_URL pointing at REST port (8080) instead of gRPC (10009)\n  - Macaroon expired / wrong scope\n  - Voltage node down\n\nFix and restart payment-proxy to reset the breaker.\n\nLast error: ${(err as Error).message ?? err}`,
      });
      return;
    }
    app.log.warn({ err, attempts: invoiceBreaker.errorCount }, 'invoice subscription error — will retry on reconnect');
  });

  return invoiceSub;
}
