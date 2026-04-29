// LNURL-pay endpoints (LUD-06 + NIP-57).
//
// Wallets resolve a Lightning address `<name>@<domain>` to:
//   GET https://<domain>/.well-known/lnurlp/<name>
// and then call the returned `callback` to fetch an invoice.
//
// We host two addresses out of the same callback:
//   zap@deepmarks.org  → brand identity (zap receipts + site tipjar)
//   dan@deepmarks.org  → personal identity (operator profile)
// The `nostrPubkey` advertised MUST match the signer that will produce
// kind:9735 receipts on settlement. Each entry in deps.lnIdentities is
// one address; unknown usernames 404.

import { createZapInvoice } from '../voltage.js';
import {
  buildLnurlpResponse,
  buildCallbackResponse,
  descriptionHashHex,
  lnurlError,
} from '../lnurl.js';
import { validateZapRequest, ZapValidationError } from '../nostr.js';
import type { Deps } from '../route-deps.js';

export function register(deps: Deps): void {
  const {
    app,
    lnd,
    zaps,
    rateLimit,
    lnIdentities,
    PUBLIC_BASE_URL,
    LN_DOMAIN,
  } = deps;

  // ─── LNURL-pay metadata (LUD-06 + NIP-57) ───────────────────────────
  app.get<{ Params: { username: string } }>(
    '/.well-known/lnurlp/:username',
    async (request, reply) => {
      const { username } = request.params;
      const signer = lnIdentities[username];
      if (!signer) {
        return reply.status(404).send(lnurlError(`no such user: ${username}`));
      }
      return buildLnurlpResponse({
        callbackUrl: `${PUBLIC_BASE_URL}/lnurlp/${username}/callback`,
        lnAddress: `${username}@${LN_DOMAIN}`,
        nostrPubkey: signer.pubkey,
      });
    },
  );

  // ─── LNURL-pay callback (invoice issuance) ──────────────────────────
  /**
   * Zap-aware invoice factory. Called by the zapper's wallet or by a
   * plain LNURL-pay wallet.
   *
   *   ?amount=<millisats>           required (LUD-06)
   *   ?nostr=<urlencoded 9734>      optional (NIP-57)
   *   ?comment=<text>               optional (LUD-12, only without nostr)
   *
   * With `nostr` present: use SHA-256 of the raw zap request JSON as the
   * description_hash and store the zap so we can publish a receipt later.
   *
   * Without `nostr`: use SHA-256 of the LUD-06 metadata string as the
   * description_hash and skip the zap-receipt path.
   */
  app.get<{
    Params: { username: string };
    Querystring: { amount?: string; nostr?: string; comment?: string };
  }>(
    '/lnurlp/:username/callback',
    async (request, reply) => {
      const { username } = request.params;
      const signer = lnIdentities[username];
      if (!signer) {
        return reply.status(404).send(lnurlError('no such user'));
      }
      // Each call creates a Voltage invoice + a Redis pending-zap row.
      // Without a cap, an attacker spams this to exhaust Voltage's
      // invoice rate limit and our HTLC slot budget. Generous enough
      // for a real wallet that retries on transient errors.
      const gate = await rateLimit('lnurl-ip', request.ip, 30, 60);
      if (!gate.ok) {
        reply.header('Retry-After', String(gate.retryAfter));
        return reply.status(429).send(lnurlError('rate limit'));
      }

      const amountStr = request.query.amount;
      if (!amountStr) {
        return reply.status(400).send(lnurlError('amount is required'));
      }
      const amountMsat = Number.parseInt(amountStr, 10);
      if (!Number.isFinite(amountMsat) || amountMsat < 1000) {
        return reply.status(400).send(lnurlError('amount must be >= 1000 msat'));
      }

      // ── NIP-57 zap flow ──
      if (request.query.nostr) {
        const rawZapRequest = request.query.nostr;

        let parsed: unknown;
        try {
          parsed = JSON.parse(rawZapRequest);
        } catch {
          return reply.status(400).send(lnurlError('nostr param is not valid JSON'));
        }

        let zapRequest;
        try {
          zapRequest = validateZapRequest(parsed, amountMsat);
        } catch (err) {
          const msg = err instanceof ZapValidationError ? err.message : 'invalid zap request';
          app.log.warn({ reason: msg }, 'zap request rejected');
          return reply.status(400).send(lnurlError(msg));
        }

        const relaysTag = zapRequest.tags.find((t) => t[0] === 'relays');
        const relays = (relaysTag ?? []).slice(1).filter((r) => r.startsWith('wss://'));

        const descHash = descriptionHashHex(rawZapRequest);

        if (!lnd) {
          return reply.status(503).send(lnurlError('lightning not configured on this server'));
        }
        try {
          const { paymentHash, invoice } = await createZapInvoice(lnd, amountMsat, descHash);
          await zaps.create({
            paymentHash,
            amountMsat,
            invoice,
            rawZapRequest,
            zapRequest,
            relays,
            createdAt: Math.floor(Date.now() / 1000),
          });
          app.log.info(
            { paymentHash, amountMsat, relays: relays.length },
            'zap invoice created',
          );
          return buildCallbackResponse(invoice);
        } catch (err) {
          app.log.error({ err, amountMsat }, 'failed to create zap invoice');
          return reply.status(502).send(lnurlError('could not create invoice'));
        }
      }

      // ── Plain LUD-06 flow (no nostr zap request) ──
      const metadata = buildLnurlpResponse({
        callbackUrl: `${PUBLIC_BASE_URL}/lnurlp/${username}/callback`,
        lnAddress: `${username}@${LN_DOMAIN}`,
        nostrPubkey: signer.pubkey,
      }).metadata;
      const descHash = descriptionHashHex(metadata);

      if (!lnd) {
        return reply.status(503).send(lnurlError('lightning not configured on this server'));
      }
      try {
        const { invoice } = await createZapInvoice(lnd, amountMsat, descHash);
        return buildCallbackResponse(invoice);
      } catch (err) {
        app.log.error({ err }, 'failed to create plain LNURL invoice');
        return reply.status(502).send(lnurlError('could not create invoice'));
      }
    },
  );
}
