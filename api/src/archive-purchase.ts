// Archive queue helpers. The lifetime path is the production path.
// createPendingArchivePurchase remains for legacy pending invoices that
// may still settle after the metered archive endpoint was disabled.

import { type AuthenticatedLnd } from 'lightning';
import {
  ARCHIVE_COST_SATS,
  INVOICE_EXPIRY_SECONDS,
  createArchiveInvoice,
} from './voltage.js';
import type { PurchaseStore } from './queue.js';

export interface PurchaseInvoiceResult {
  paymentHash: string;
  invoice: string;
  amountSats: number;
  expiresInSeconds: number;
}

export class ArchiveUnavailableError extends Error {
  constructor() {
    super('lightning not configured on this server');
    this.name = 'ArchiveUnavailableError';
  }
}

/**
 * Legacy metered archive helper: create a fresh BOLT-11 invoice and
 * persist the pending record so the invoice-settlement handler can
 * enqueue the job. New user-facing routes no longer call this.
 *
 * Callers handle auth / input validation; this is the shared pure path.
 */
export async function createPendingArchivePurchase(opts: {
  lnd: AuthenticatedLnd | null;
  purchases: PurchaseStore;
  url: string;
  userPubkey: string;
  eventId?: string;
  tier?: 'public' | 'private';
  archiveKey?: string;
  mirrorUrls?: string[];
  bookmarkSavedAt?: number;
  originalUrl?: string;
}): Promise<PurchaseInvoiceResult> {
  if (!opts.lnd) throw new ArchiveUnavailableError();

  const { paymentHash, invoice } = await createArchiveInvoice(opts.lnd, opts.url);
  await opts.purchases.create({
    url: opts.url,
    eventId: opts.eventId,
    userPubkey: opts.userPubkey,
    paymentHash,
    invoice,
    amountSats: ARCHIVE_COST_SATS,
    status: 'pending',
    createdAt: Math.floor(Date.now() / 1000),
    tier: opts.tier,
    archiveKey: opts.archiveKey,
    mirrorUrls: opts.mirrorUrls,
    bookmarkSavedAt: opts.bookmarkSavedAt,
    originalUrl: opts.originalUrl,
  });

  return {
    paymentHash,
    invoice,
    amountSats: ARCHIVE_COST_SATS,
    expiresInSeconds: INVOICE_EXPIRY_SECONDS,
  };
}

export interface LifetimeArchiveResult {
  /** Synthetic hash used as the jobId; never paid, purely for tracking. */
  paymentHash: string;
  amountSats: 0;
}

/**
 * Direct-enqueue path for lifetime members — skips invoice creation
 * entirely. Caller MUST have verified the pubkey is a paid lifetime
 * member before invoking this; we don't re-check here so the unit is
 * easy to test.
 *
 * The synthetic payment hash is prefixed `lifetime:` so it never
 * collides with a real Lightning payment hash (which are always hex).
 * Downstream code (archive-worker status polling) treats it as an
 * opaque string — no paid-or-not checks exist past this point, because
 * the enqueue itself IS the grant.
 */
export async function enqueueLifetimeArchive(opts: {
  purchases: PurchaseStore;
  url: string;
  userPubkey: string;
  paymentHash?: string;
  eventId?: string;
  tier?: 'public' | 'private';
  archiveKey?: string;
  mirrorUrls?: string[];
  bookmarkSavedAt?: number;
  originalUrl?: string;
  capturedHtmlBase64?: string;
  capturedTitle?: string;
  capturedContentType?: string;
  capturedAt?: number;
  captureSource?: 'browser-extension';
}): Promise<LifetimeArchiveResult> {
  const paymentHash = opts.paymentHash ?? createLifetimeArchiveJobId();
  const now = Math.floor(Date.now() / 1000);
  await opts.purchases.create({
    url: opts.url,
    eventId: opts.eventId,
    userPubkey: opts.userPubkey,
    paymentHash,
    invoice: '',
    amountSats: 0,
    status: 'pending',
    createdAt: now,
    tier: opts.tier,
    archiveKey: opts.archiveKey,
    mirrorUrls: opts.mirrorUrls,
    bookmarkSavedAt: opts.bookmarkSavedAt,
    originalUrl: opts.originalUrl,
    capturedHtmlBase64: opts.capturedHtmlBase64,
    capturedTitle: opts.capturedTitle,
    capturedContentType: opts.capturedContentType,
    capturedAt: opts.capturedAt,
    captureSource: opts.captureSource,
  });
  // Mark it paid + enqueue in one swoop — no invoice settlement needed.
  const rec = await opts.purchases.markPaid(paymentHash);
  if (rec) {
    try {
      await opts.purchases.enqueueArchiveJob(rec);
    } catch (err) {
      await opts.purchases.rollbackToPending(paymentHash).catch(() => {});
      throw err;
    }
  }
  return { paymentHash, amountSats: 0 };
}

export function createLifetimeArchiveJobId(): `lifetime:${string}` {
  return `lifetime:${cryptoRandomHex()}`;
}

function cryptoRandomHex(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}
