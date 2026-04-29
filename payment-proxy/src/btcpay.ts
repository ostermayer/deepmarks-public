// BTCPay Greenfield API client for the lifetime-tier upgrade flow.
//
// Why BTCPay instead of our direct-Voltage path? The hosted checkout page
// (QR, payment-method fallback, expiry UX, receipt) is strictly less code
// than hand-rolling the same UI, and BTCPay already talks to the same
// Voltage node we use for archive invoices. Archive purchases and zaps
// stay on the direct Voltage path — they're programmatic / server-initiated
// and don't need a checkout page.
//
// Auth: Greenfield API keys go in `Authorization: token <key>`. The key is
// scoped to a single store via permissions — we never send the store ID in
// the header, only in the URL path.
//
// Webhooks: BTCPay signs delivery bodies with HMAC-SHA256 using a per-hook
// secret. The signature is sent in the `BTCPay-Sig` header as `sha256=<hex>`.
// We verify with a constant-time compare to stop timing-oracle attacks.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface BtcPayConfig {
  /** Base URL without trailing slash, e.g. `https://btcpay0.voltageapp.io`. */
  url: string;
  storeId: string;
  apiKey: string;
  webhookSecret: string;
}

/**
 * Load BTCPay config from env. Returns null when any required var is
 * missing so the service can boot without BTCPay (and /account/lifetime
 * returns 503).
 */
export function btcPayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BtcPayConfig | null {
  const url = env.BTCPAY_URL;
  const storeId = env.BTCPAY_STORE_ID;
  const apiKey = env.BTCPAY_API_KEY;
  const webhookSecret = env.BTCPAY_WEBHOOK_SECRET;
  if (!url || !storeId || !apiKey || !webhookSecret) return null;
  return {
    url: url.replace(/\/+$/, ''),
    storeId,
    apiKey,
    webhookSecret,
  };
}

export interface LifetimeInvoiceRequest {
  /** Hex pubkey of the buyer — stored in invoice metadata so the webhook
   *  can look it up on settlement without our own DB round-trip. */
  pubkey: string;
  /** Price in sats. Stored on BTCPay in SATS currency so conversion is
   *  deterministic regardless of BTC/USD swings. */
  amountSats: number;
  /** Optional free-form label surfaced on the BTCPay checkout page. */
  description?: string;
  /** Where to send the buyer after successful payment. */
  redirectUrl?: string;
}

export interface BtcPayInvoice {
  id: string;
  storeId: string;
  status: string;
  checkoutLink: string;
  amount: string;
  currency: string;
  expirationTime: number;
  metadata: Record<string, unknown>;
}

/**
 * POST /api/v1/stores/{storeId}/invoices.
 *
 * BTCPay supports `currency: "SATS"` natively so the 21,000-sat price is
 * stored as-is without any BTC/USD conversion. Pubkey is attached as
 * metadata.deepmarksPubkey so the settlement webhook can recover it.
 */
export async function createLifetimeInvoice(
  config: BtcPayConfig,
  req: LifetimeInvoiceRequest,
): Promise<BtcPayInvoice> {
  const body = buildInvoiceBody(req);
  const res = await fetch(`${config.url}/api/v1/stores/${config.storeId}/invoices`, {
    method: 'POST',
    headers: {
      Authorization: `token ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new BtcPayError(`create invoice failed: ${res.status} ${text}`);
  }
  return (await res.json()) as BtcPayInvoice;
}

/**
 * Paginated list of invoices for the store. Used by the reconcile path to
 * rebuild LifetimeStore from BTCPay's record-of-truth. Filters by status
 * server-side so we don't transfer expired / processing invoices we don't
 * care about. Pagination is `skip + take`; the caller is responsible for
 * driving the loop until the page is empty.
 */
export async function listInvoices(
  config: BtcPayConfig,
  opts: { status?: string[]; skip?: number; take?: number } = {},
): Promise<BtcPayInvoice[]> {
  const params = new URLSearchParams();
  for (const s of opts.status ?? []) params.append('status', s);
  if (opts.skip !== undefined) params.set('skip', String(opts.skip));
  if (opts.take !== undefined) params.set('take', String(opts.take));
  const qs = params.toString();
  const url = `${config.url}/api/v1/stores/${config.storeId}/invoices${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, { headers: { Authorization: `token ${config.apiKey}` } });
  if (!res.ok) {
    const text = await res.text();
    throw new BtcPayError(`list invoices failed: ${res.status} ${text}`);
  }
  return (await res.json()) as BtcPayInvoice[];
}

/**
 * Retrieve a known invoice. Used by the webhook handler as a second check
 * after signature verification: a malicious caller who somehow recovers the
 * shared secret still can't mark a random invoice as paid, because we
 * re-read the authoritative status from BTCPay.
 */
export async function getInvoice(
  config: BtcPayConfig,
  invoiceId: string,
): Promise<BtcPayInvoice> {
  const res = await fetch(
    `${config.url}/api/v1/stores/${config.storeId}/invoices/${encodeURIComponent(invoiceId)}`,
    { headers: { Authorization: `token ${config.apiKey}` } },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new BtcPayError(`get invoice failed: ${res.status} ${text}`);
  }
  return (await res.json()) as BtcPayInvoice;
}

export class BtcPayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BtcPayError';
  }
}

/** Exposed for testing — the JSON body we post to BTCPay. */
export function buildInvoiceBody(req: LifetimeInvoiceRequest): Record<string, unknown> {
  return {
    amount: req.amountSats.toString(),
    currency: 'SATS',
    metadata: {
      orderId: `deepmarks-lifetime-${req.pubkey}`,
      itemDesc: req.description ?? 'Deepmarks lifetime membership',
      deepmarksPubkey: req.pubkey,
      deepmarksProduct: 'lifetime',
    },
    checkout: {
      redirectURL: req.redirectUrl,
      redirectAutomatically: true,
      // Users can fund via LN, on-chain fallback, or LNURL — BTCPay picks
      // based on store config. We don't lock the method here so the store
      // admin (user) can adjust without a code change.
    },
  };
}

/**
 * Verify a BTCPay webhook signature. The header is formatted as
 * `sha256=<hex>` and computed over the raw request body using the
 * per-hook secret. Pass the EXACT bytes Fastify received — serializing
 * `request.body` to JSON and re-hashing will break the signature when the
 * key order or whitespace differs from the original.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = signatureHeader.slice('sha256='.length);
  const mac = createHmac('sha256', secret);
  mac.update(rawBody);
  const actual = mac.digest('hex');
  if (expected.length !== actual.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
  } catch {
    return false;
  }
}

// Narrow subset of the webhook payload we care about. BTCPay sends many
// more fields; they're irrelevant to the lifetime flow.
export interface BtcPayWebhookPayload {
  deliveryId: string;
  webhookId: string;
  originalDeliveryId: string;
  isRedelivery: boolean;
  type: string;
  invoiceId: string;
  storeId: string;
  metadata?: Record<string, unknown>;
}

/** Event names we act on. Settled is the only one required; expired is a cleanup hint. */
export const BTCPAY_SETTLED = 'InvoiceSettled';
export const BTCPAY_EXPIRED = 'InvoiceExpired';
