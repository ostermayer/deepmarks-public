// LNURL-pay endpoints (LUD-06 + NIP-57).
//
// Wallets resolve a Lightning address `<name>@<domain>` to:
//   GET https://<domain>/.well-known/lnurlp/<name>
// and then call the returned `callback` to fetch an invoice.
//
// We host two addresses out of the same callback:
//   zap@deepmarks.org  → admin/operational signer (zap receipts + site tipjar)
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
import { validateSafePublicHttpUrl } from '../safe-url.js';
import type { Deps } from '../route-deps.js';

const LNURL_PROXY_TIMEOUT_MS = 8_000;
const LNURL_PROXY_MAX_JSON_BYTES = 64 * 1024;
const LNURL_PROXY_MAX_ZAP_REQUEST_BYTES = 16 * 1024;
const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/i;

interface ExternalLnurlPayMeta {
  callback?: unknown;
  minSendable?: unknown;
  maxSendable?: unknown;
  metadata?: unknown;
  tag?: unknown;
  allowsNostr?: unknown;
  nostrPubkey?: unknown;
  status?: unknown;
  reason?: unknown;
}

interface NormalizedLnurlPayMeta {
  callback: string;
  minSendable: number;
  maxSendable: number;
  metadata: string;
  tag: 'payRequest';
  allowsNostr: boolean;
  nostrPubkey: string;
}

export function register(deps: Deps): void {
  const {
    app,
    lnd,
    zaps,
    rateLimit,
    gateRateLimit,
    lnIdentities,
    PUBLIC_BASE_URL,
    LN_DOMAIN,
  } = deps;

  // ─── External LNURL-pay proxy for native apps ───────────────────────
  //
  // Capacitor iOS/Android WebViews can fail CORS/ATS checks when calling
  // arbitrary LNURL endpoints directly. These routes do not sign anything
  // and never receive nsecs/NWC secrets; the app signs the kind:9734 zap
  // request locally, then this server only fetches public LNURL metadata
  // and callback JSON.
  app.get<{
    Querystring: { payUrl?: string };
  }>(
    '/lnurl/resolve',
    async (request, reply) => {
      if (!(await gateRateLimit(reply, 'lnurl-proxy-ip', request.ip, 60, 60))) return reply;

      let payUrl: URL;
      try {
        payUrl = validateExternalLnurlUrl(request.query.payUrl ?? '');
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }

      try {
        const meta = await fetchExternalLnurlMeta(payUrl);
        reply.header('cache-control', 'public, max-age=60');
        return reply.send({ payUrl: payUrl.toString(), meta });
      } catch (err) {
        return reply.status(502).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{
    Body: {
      payUrl?: unknown;
      amount?: unknown;
      nostr?: unknown;
      lnurl?: unknown;
    };
  }>(
    '/lnurl/zap-invoice',
    async (request, reply) => {
      if (!(await gateRateLimit(reply, 'lnurl-proxy-ip', request.ip, 60, 60))) return reply;

      let payUrl: URL;
      try {
        payUrl = validateExternalLnurlUrl(stringField(request.body?.payUrl, 'payUrl'));
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }

      const amount = numberField(request.body?.amount, 'amount');
      if (!Number.isSafeInteger(amount) || amount < 1_000) {
        return reply.status(400).send({ error: 'amount must be an integer >= 1000 msat' });
      }

      const nostr = stringField(request.body?.nostr, 'nostr');
      if (!nostr || new TextEncoder().encode(nostr).byteLength > LNURL_PROXY_MAX_ZAP_REQUEST_BYTES) {
        return reply.status(400).send({ error: 'nostr zap request is missing or too large' });
      }
      try {
        const parsed = JSON.parse(nostr) as { kind?: unknown };
        if (parsed.kind !== 9734) return reply.status(400).send({ error: 'nostr event must be kind 9734' });
      } catch {
        return reply.status(400).send({ error: 'nostr param is not valid JSON' });
      }

      const lnurl = stringField(request.body?.lnurl, 'lnurl');
      if (!/^lnurl1[02-9ac-hj-np-z]+$/i.test(lnurl)) {
        return reply.status(400).send({ error: 'lnurl must be bech32 encoded' });
      }

      try {
        const meta = await fetchExternalLnurlMeta(payUrl);
        if (amount < meta.minSendable || amount > meta.maxSendable) {
          return reply.status(400).send({
            error: `amount must be between ${meta.minSendable} and ${meta.maxSendable} msat`,
          });
        }

        const callbackUrl = validateExternalLnurlUrl(meta.callback);
        callbackUrl.searchParams.set('amount', String(amount));
        callbackUrl.searchParams.set('nostr', nostr);
        callbackUrl.searchParams.set('lnurl', lnurl);

        const data = await fetchExternalJson(callbackUrl);
        const pr = typeof data.pr === 'string' ? data.pr : '';
        const status = typeof data.status === 'string' ? data.status : '';
        const reason = typeof data.reason === 'string' ? data.reason : '';
        if (status.toUpperCase() === 'ERROR') {
          return reply.status(502).send({ error: reason || 'LNURL callback returned an error' });
        }
        if (!pr) return reply.status(502).send({ error: reason || 'LNURL callback did not return an invoice' });
        reply.header('cache-control', 'no-store');
        return reply.send({ pr });
      } catch (err) {
        return reply.status(502).send({ error: (err as Error).message });
      }
    },
  );

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

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value.trim();
}

function numberField(value: unknown, name: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`${name} must be a number`);
}

function validateExternalLnurlUrl(raw: string): URL {
  const parsed = validateSafePublicHttpUrl(raw);
  if (parsed.protocol !== 'https:') throw new Error('LNURL URL must use https');
  if (parsed.toString().length > 2_048) throw new Error('LNURL URL is too long');
  return parsed;
}

async function fetchExternalLnurlMeta(payUrl: URL): Promise<NormalizedLnurlPayMeta> {
  const raw = await fetchExternalJson(payUrl);
  return normalizeExternalLnurlMeta(raw);
}

async function fetchExternalJson(url: URL): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(LNURL_PROXY_TIMEOUT_MS),
    redirect: 'manual',
    headers: {
      accept: 'application/json,*/*;q=0.5',
      'user-agent': 'deepmarks-lnurl-proxy/1.0 (+https://deepmarks.org)',
    },
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error('LNURL endpoint redirected; redirects are not followed by the proxy');
  }
  const body = await readCappedText(res);
  let parsed: unknown = {};
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new Error('LNURL endpoint returned invalid JSON');
  }
  if (!res.ok) {
    const reason = parsed && typeof parsed === 'object' && typeof (parsed as { reason?: unknown }).reason === 'string'
      ? `: ${(parsed as { reason: string }).reason}`
      : '';
    throw new Error(`LNURL endpoint returned ${res.status}${reason}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LNURL endpoint returned invalid JSON');
  }
  return parsed as Record<string, unknown>;
}

async function readCappedText(res: Response): Promise<string> {
  const declaredLen = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declaredLen) && declaredLen > LNURL_PROXY_MAX_JSON_BYTES) {
    throw new Error('LNURL response is too large');
  }
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  while (received < LNURL_PROXY_MAX_JSON_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = LNURL_PROXY_MAX_JSON_BYTES - received;
    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, remaining));
      received = LNURL_PROXY_MAX_JSON_BYTES;
      truncated = true;
      break;
    }
    chunks.push(value);
    received += value.byteLength;
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  if (truncated) throw new Error('LNURL response is too large');
  const buf = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

function normalizeExternalLnurlMeta(raw: Record<string, unknown>): NormalizedLnurlPayMeta {
  const meta = raw as ExternalLnurlPayMeta;
  if (meta.status === 'ERROR') {
    throw new Error(typeof meta.reason === 'string' ? meta.reason : 'LNURL endpoint returned an error');
  }
  if (meta.tag !== 'payRequest') throw new Error('LNURL endpoint is not a payRequest');
  const callback = typeof meta.callback === 'string' ? meta.callback : '';
  validateExternalLnurlUrl(callback);
  const minSendable = finitePositiveInteger(meta.minSendable);
  const maxSendable = finitePositiveInteger(meta.maxSendable);
  if (minSendable === null || maxSendable === null || minSendable > maxSendable) {
    throw new Error('LNURL endpoint returned invalid send limits');
  }
  const metadata = typeof meta.metadata === 'string' ? meta.metadata : '';
  if (!metadata) throw new Error('LNURL endpoint returned invalid metadata');
  if (meta.allowsNostr !== true || typeof meta.nostrPubkey !== 'string' || !HEX_PUBKEY_RE.test(meta.nostrPubkey)) {
    throw new Error('LNURL endpoint does not advertise Nostr zap support');
  }
  return {
    callback,
    minSendable,
    maxSendable,
    metadata,
    tag: 'payRequest',
    allowsNostr: true,
    nostrPubkey: meta.nostrPubkey.toLowerCase(),
  };
}

function finitePositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}
