// POST /account/lifetime — start a BTCPay invoice for the lifetime tier.
// POST /btcpay/webhook  — BTCPay settlement → mark lifetime + publish label.

/** Accept only redirectUrl values that point at our own origin. Returns
 *  undefined for anything else, which leaves BTCPay using its default. */
function sanitizeRedirectUrl(raw: unknown, ourOrigin: string): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  // Same-origin relative paths are always safe.
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return undefined; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  let allowed: URL;
  try { allowed = new URL(ourOrigin); } catch { return undefined; }
  // Exact host match — no subdomain wildcards (could be a CNAME victim).
  if (parsed.host !== allowed.host) return undefined;
  return parsed.toString();
}

import {
  createLifetimeInvoice,
  getInvoice,
  verifyWebhookSignature,
  BTCPAY_SETTLED,
} from '../btcpay.js';
import { computeLifetimePriceSats } from '../lifetime.js';
import { publishLifetimeLabel } from '../nostr.js';
import type { Deps } from '../route-deps.js';

export function register(deps: Deps): void {
  const {
    app,
    accounts,
    lifetimeStore,
    btcPay,
    redis,
    signers,
    relayPool,
    alerter,
    requireNip98,
    PUBLIC_BASE_URL,
    LIFETIME_LABEL_RELAYS,
  } = deps;

  // ── POST /account/lifetime ──────────────────────────────────────────
  // Start a BTCPay invoice for the lifetime tier. NIP-98 auth binds the
  // invoice to the paying pubkey; the settlement webhook stamps
  // `LifetimeStore.markPaid(pubkey)` on success. Idempotent — paying
  // twice is harmless; the second payment settles but the first paidAt
  // timestamp stays.
  app.post('/account/lifetime', async (request, reply) => {
    if (!btcPay) {
      return reply.status(503).send({ error: 'lifetime upgrades are not available on this server' });
    }
    const authCheck = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/account/lifetime`,
      'POST',
    );
    if (!authCheck) return;
    const pubkey = authCheck.pubkey;

    if (await lifetimeStore.isPaid(pubkey)) {
      return reply.status(409).send({ error: 'already a lifetime member' });
    }

    // Price is server-authoritative — body.amountSats from the buyer is
    // ignored. Without this, a buyer can pass amountSats:1, pay 1 sat,
    // and become a lifetime member because the webhook handler did not
    // (and still does not, beyond the equality check we added below)
    // recompute the expected price.
    const body = (request.body ?? {}) as { redirectUrl?: string };
    const amountSats = computeLifetimePriceSats();
    // Open-redirect guard: BTCPay's checkout.redirectURL with
    // redirectAutomatically:true will navigate the buyer to whatever
    // host we pass. Without origin validation, an attacker who can get
    // someone to call this endpoint (it's NIP-98-gated, so they need
    // their own nsec — but that's cheap) can mint a deepmarks.org-side
    // checkout link that punts the user to evil.com after settlement.
    // Restrict to our own public base + same-origin relative paths.
    const redirectUrl = sanitizeRedirectUrl(body.redirectUrl, PUBLIC_BASE_URL);

    try {
      const invoice = await createLifetimeInvoice(btcPay, {
        pubkey,
        amountSats,
        redirectUrl,
      });
      await lifetimeStore.stagePending({
        pubkey,
        invoiceId: invoice.id,
        amountSats,
        createdAt: Math.floor(Date.now() / 1000),
      });
      app.log.info({ invoiceId: invoice.id, pubkey, amountSats }, 'lifetime invoice created');
      return {
        invoiceId: invoice.id,
        checkoutLink: invoice.checkoutLink,
        amountSats,
        expiresAt: invoice.expirationTime,
      };
    } catch (err) {
      app.log.error({ err }, 'btcpay invoice creation failed');
      return reply.status(502).send({ error: 'upstream invoicing failed' });
    }
  });

  // ── POST /btcpay/webhook ────────────────────────────────────────────
  // BTCPay posts here on invoice state changes. We require:
  //   1. HMAC signature matches our shared secret (raw-body compare)
  //   2. Invoice re-read from BTCPay reports Settled status
  //   3. Invoice metadata carries the buyer pubkey we attached at creation
  // Only then do we stamp LifetimeStore.markPaid().
  app.post('/btcpay/webhook', async (request, reply) => {
    if (!btcPay) return reply.status(503).send({ error: 'btcpay not configured' });
    const raw = (request as { rawBody?: Buffer }).rawBody;
    if (!raw) {
      app.log.warn('btcpay webhook missing raw body');
      return reply.status(400).send({ error: 'missing body' });
    }
    const sig = request.headers['btcpay-sig'];
    const sigStr = Array.isArray(sig) ? sig[0] : sig;
    if (!verifyWebhookSignature(raw, sigStr, btcPay.webhookSecret)) {
      app.log.warn('btcpay webhook signature rejected');
      return reply.status(401).send({ error: 'bad signature' });
    }

    const payload = request.body as { type?: string; invoiceId?: string } | undefined;
    if (!payload?.type || !payload.invoiceId) {
      return reply.status(400).send({ error: 'malformed event' });
    }

    // We only act on settlement. Everything else (created, processing,
    // expired, invalid) we acknowledge with 200 so BTCPay stops retrying.
    if (payload.type !== BTCPAY_SETTLED) {
      return reply.send({ ok: true, ignored: payload.type });
    }

    try {
      const invoice = await getInvoice(btcPay, payload.invoiceId);
      if (invoice.status !== 'Settled') {
        app.log.warn({ invoiceId: payload.invoiceId, status: invoice.status }, 'btcpay webhook claimed settlement but invoice is not settled');
        return reply.status(400).send({ error: 'invoice not settled' });
      }
      const pending = await lifetimeStore.getPending(payload.invoiceId);
      const pubkey = typeof invoice.metadata?.deepmarksPubkey === 'string'
        ? (invoice.metadata.deepmarksPubkey as string)
        : pending?.pubkey;
      if (!pubkey) {
        app.log.error({ invoiceId: payload.invoiceId }, 'btcpay settled invoice with no buyer pubkey');
        void alerter.alert({
          severity: 'critical',
          key: 'btcpay-no-pubkey',
          subject: `BTCPay settled invoice ${payload.invoiceId.slice(0, 12)}… has no buyer pubkey`,
          body: `A BTCPay invoice settled but the metadata.deepmarksPubkey is missing AND no pending record exists. Money received with no way to attribute it. Manual reconcile via the BTCPay dashboard is required.\n\nInvoice ID: ${payload.invoiceId}\nAmount: ${invoice.amount}`,
        });
        return reply.status(200).send({ ok: true, skipped: 'no-pubkey' });
      }
      // Verify the settled amount matches what we billed for. Without
      // this an attacker could craft a BTCPay invoice for 1 sat and
      // still get the lifetime stamp once it's paid. Use the pending
      // record we staged at creation time as the source of truth — that
      // value was server-computed, never user-provided.
      const expectedSats = pending?.amountSats ?? computeLifetimePriceSats();
      const settledSats = Number.parseInt(invoice.amount, 10);
      if (!Number.isFinite(settledSats) || settledSats < expectedSats) {
        app.log.warn(
          { invoiceId: payload.invoiceId, pubkey, expectedSats, settledSats: invoice.amount },
          'btcpay settled invoice underpaid — refusing to stamp lifetime',
        );
        void alerter.alert({
          severity: 'warning',
          key: 'btcpay-underpaid',
          subject: `BTCPay settled invoice ${payload.invoiceId.slice(0, 12)}… is underpaid`,
          body: `Invoice ${payload.invoiceId} settled but received ${invoice.amount} sats vs expected ${expectedSats}. NOT stamping lifetime — refund to the buyer (${pubkey}) is appropriate. Could be an attacker probing the underpayment guard.`,
        });
        return reply.status(200).send({ ok: true, skipped: 'underpaid' });
      }
      await lifetimeStore.markPaid(pubkey);
      await lifetimeStore.clearPending(payload.invoiceId);
      // Idempotency gate for the side-effects below. BTCPay retries any
      // 5xx response from us; without this, the second delivery would
      // republish a kind:1985 label and re-touch the account record.
      // markPaid itself is already idempotent via SET NX inside
      // lifetime.ts; this gate covers the fan-out.
      const sideEffectGate = await redis.set(
        `dm:lifetime-fanout:${payload.invoiceId}`,
        '1',
        'EX',
        60 * 60 * 24 * 30, // 30 days — well past any sane retry window
        'NX',
      );
      if (sideEffectGate === 'OK') {
        // Best-effort: if this pubkey also has an email-linked account,
        // mirror the flag there so legacy code paths still light up.
        try { await accounts.markLifetimePaid(pubkey); } catch { /* no account yet — fine */ }
        // Durability layer #2: publish a NIP-32 label so the attestation
        // survives on relays even if our Redis is wiped. Best-effort —
        // we don't fail the webhook just because a relay was unreachable.
        publishLifetimeLabel(
          signers.brand,
          { memberPubkey: pubkey, paidAt: Math.floor(Date.now() / 1000), invoiceId: payload.invoiceId },
          LIFETIME_LABEL_RELAYS,
          relayPool,
        ).then(({ ok, failed }) => {
          app.log.info({ pubkey, ok: ok.length, failed: failed.length }, 'lifetime label published');
        }).catch((err) => {
          app.log.warn({ err, pubkey }, 'lifetime label publish failed');
        });
      } else {
        app.log.info({ invoiceId: payload.invoiceId, pubkey }, 'lifetime fan-out already done — skipping');
      }
      app.log.info({ invoiceId: payload.invoiceId, pubkey }, 'lifetime tier stamped');
      return { ok: true };
    } catch (err) {
      // Return 200 so BTCPay doesn't keep retrying on a transient bug
      // here. markPaid is already done idempotently; what's left is
      // log noise we want to fix without amplification.
      app.log.error({ err }, 'btcpay webhook handler failed (returning 200 to stop retries)');
      return reply.status(200).send({ ok: true, warning: 'handler error logged' });
    }
  });
}
