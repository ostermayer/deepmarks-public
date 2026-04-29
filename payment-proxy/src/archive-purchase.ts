// Shared archive-purchase path — called from:
//   POST /archive/purchase      (app-facing, legacy REST shape)
//   POST /api/v1/archives       (API key-authenticated shape)
//
// Keeping a single implementation means both routes can't drift on invoice
// creation, persistence, or pricing. See Flow B in deepmarks-architecture.html.

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
 * Create a fresh BOLT-11 invoice for an archive purchase + persist the
 * pending-record so the invoice-settlement handler can enqueue the job.
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
  eventId?: string;
  tier?: 'public' | 'private';
  archiveKey?: string;
}): Promise<LifetimeArchiveResult> {
  const paymentHash = `lifetime:${cryptoRandomHex()}`;
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
  });
  // Mark it paid + enqueue in one swoop — no invoice settlement needed.
  const rec = await opts.purchases.markPaid(paymentHash);
  if (rec) await opts.purchases.enqueueArchiveJob(rec);
  return { paymentHash, amountSats: 0 };
}

function cryptoRandomHex(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}
