import {
  authenticatedLndGrpc,
  createInvoice,
  type AuthenticatedLnd,
} from 'lightning';

export const ARCHIVE_COST_SATS = 500;
export const INVOICE_EXPIRY_SECONDS = 60 * 60;      // 1 hour for archives
export const ZAP_INVOICE_EXPIRY_SECONDS = 60 * 10;  // 10 min for zaps

export function connectToVoltage(): AuthenticatedLnd | null {
  const rawSocket = process.env.VOLTAGE_REST_URL;
  const macaroon = process.env.VOLTAGE_INVOICE_MACAROON;

  // Dev-friendly: if Voltage isn't configured, let the service boot
  // without Lightning. Endpoints that need it must null-check the lnd
  // handle and return 503.
  if (!rawSocket || !macaroon || rawSocket.startsWith('https://your-node.')) {
    return null;
  }

  const socket = rawSocket.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const cert = process.env.VOLTAGE_TLS_CERT;

  const { lnd } = authenticatedLndGrpc({
    socket,
    macaroon,
    ...(cert ? { cert } : {}),
  });

  return lnd;
}

/**
 * Create a BOLT-11 invoice for an archive purchase (plain description).
 */
export async function createArchiveInvoice(
  lnd: AuthenticatedLnd,
  url: string,
): Promise<{ paymentHash: string; invoice: string; expiresAt: Date }> {
  const shortUrl = url.length > 80 ? `${url.slice(0, 77)}...` : url;
  const description = `deepmarks archive: ${shortUrl}`;
  const expiresAt = new Date(Date.now() + INVOICE_EXPIRY_SECONDS * 1000);

  const result = await createInvoice({
    lnd,
    tokens: ARCHIVE_COST_SATS,
    description,
    expires_at: expiresAt.toISOString(),
  });

  return {
    paymentHash: result.id,
    invoice: result.request,
    expiresAt,
  };
}

/**
 * Create a BOLT-11 invoice for a NIP-57 zap. Uses description_hash so the
 * zap request JSON (which won't fit in a BOLT-11 description) can still
 * be committed to.
 *
 * @param amountMsat       amount in millisats (as per NIP-57 zap request)
 * @param descriptionHash  SHA-256 of the raw zap request JSON string, hex
 */
export async function createZapInvoice(
  lnd: AuthenticatedLnd,
  amountMsat: number,
  descriptionHash: string,
): Promise<{ paymentHash: string; invoice: string; expiresAt: Date }> {
  if (amountMsat <= 0 || !Number.isFinite(amountMsat)) {
    throw new Error(`invalid amountMsat: ${amountMsat}`);
  }
  if (!/^[0-9a-f]{64}$/i.test(descriptionHash)) {
    throw new Error('descriptionHash must be 64-char hex');
  }

  const expiresAt = new Date(Date.now() + ZAP_INVOICE_EXPIRY_SECONDS * 1000);

  // `lightning` accepts mtokens for millisat precision and description_hash
  // as a hex string. LND verifies the description commitment when the
  // invoice is paid.
  const result = await createInvoice({
    lnd,
    mtokens: amountMsat.toString(),
    description_hash: descriptionHash,
    expires_at: expiresAt.toISOString(),
  });

  return {
    paymentHash: result.id,
    invoice: result.request,
    expiresAt,
  };
}

// ── Respectful-of-Voltage connectivity helpers ─────────────────────────
//
// The two failure modes we've seen in practice:
//   1. Misconfigured endpoint (REST URL on port 8080 instead of gRPC 10009).
//      The `lightning` package retries this forever with no backoff, which
//      hammers Voltage with garbage requests every ~30 s.
//   2. Wrong-scope macaroon (admin instead of invoice, or outright garbage).
//      Each invocation returns a permission error.
//
// We defend against both by: (a) creating a 1-sat throwaway invoice at
// startup so we know the connection + macaroon scope are live before we let
// traffic or the invoice subscription anywhere near it; (b) a small circuit
// breaker that caps runaway reconnect logging + stops the stream after
// repeated failures.

export type VoltageValidation =
  | { ok: true }
  | { ok: false; reason: string; hint?: string };

/**
 * One-shot health check. We test `invoices:write` (the only perm we actually
 * need) by creating a tiny short-lived invoice — Voltage's default
 * `invoice.macaroon` does NOT include `info:read`, so getWalletInfo() would
 * spuriously fail the handshake on a perfectly working node.
 */
export async function validateVoltageConnection(
  lnd: AuthenticatedLnd,
  create: typeof createInvoice = createInvoice,
): Promise<VoltageValidation> {
  try {
    await create({
      lnd,
      tokens: 1,
      description: 'deepmarks handshake',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    return { ok: true };
  } catch (e: unknown) {
    return classifyVoltageError(e);
  }
}

/** Exported for unit testing; turns a raw `lightning` error into a friendly reason + hint. */
export function classifyVoltageError(e: unknown): {
  ok: false;
  reason: string;
  hint?: string;
} {
  // `lightning` throws tuples like [503, 'UnexpectedError', { err: <gRPC err> }]
  // where the gRPC err carries { code, details, metadata }. Fall back to the
  // thrown value itself when it's a plain Error.
  const flat = Array.isArray(e) ? e : [null, null, e];
  const envelope = flat[2] as { err?: { details?: string }; details?: string } | null;
  const details = String(
    envelope?.err?.details ??
      envelope?.details ??
      (e as { message?: string })?.message ??
      e,
  );
  if (/404/.test(details) || /unimplemented/i.test(details)) {
    return {
      ok: false,
      reason: `Voltage handshake returned 404: ${details.slice(0, 160)}`,
      hint: 'VOLTAGE_REST_URL should be the gRPC socket (usually port 10009), not the REST port (8080). Check your Voltage dashboard → Connect → gRPC.',
    };
  }
  if (/permission|macaroon|unauthorized/i.test(details)) {
    return {
      ok: false,
      reason: `Voltage rejected macaroon: ${details.slice(0, 160)}`,
      hint: 'VOLTAGE_INVOICE_MACAROON must be the invoice-only macaroon as hex. NEVER admin.macaroon.',
    };
  }
  if (/getaddrinfo|econnrefused|enotfound|timeout/i.test(details)) {
    return {
      ok: false,
      reason: `Cannot reach Voltage: ${details.slice(0, 160)}`,
      hint: 'Verify VOLTAGE_REST_URL hostname is reachable and the node is online.',
    };
  }
  return { ok: false, reason: details.slice(0, 200) };
}

/**
 * Caps runaway subscription-error logging and cleanly stops a stream after
 * too many consecutive failures. Keeps us from spamming Voltage (well, the
 * underlying gRPC client does the actual retrying — but by removing our
 * listeners we stop logging noise AND signal the lib to tear down).
 *
 * Errors are considered "consecutive" inside a rolling window; any success
 * fully resets the counter.
 */
export class SubscriptionCircuitBreaker {
  private consecutiveErrors = 0;
  private lastErrorAt = 0;
  private tripped = false;

  constructor(
    public readonly ceiling: number = 5,
    public readonly windowMs: number = 5 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true when the caller should silently continue, false when tripped this call. */
  recordError(): 'continue' | 'trip' | 'silent' {
    if (this.tripped) return 'silent';
    const t = this.now();
    if (t - this.lastErrorAt > this.windowMs) this.consecutiveErrors = 0;
    this.lastErrorAt = t;
    this.consecutiveErrors++;
    if (this.consecutiveErrors >= this.ceiling) {
      this.tripped = true;
      return 'trip';
    }
    return 'continue';
  }

  /** A successful event resets the counter — keeps a flaky relay from eventually tripping. */
  recordSuccess(): void {
    this.consecutiveErrors = 0;
    this.tripped = false;
  }

  get isTripped(): boolean {
    return this.tripped;
  }
  get errorCount(): number {
    return this.consecutiveErrors;
  }
}
