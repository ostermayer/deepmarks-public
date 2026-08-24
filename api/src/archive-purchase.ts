// Archive queue helpers. The lifetime path is the only production path —
// the legacy metered-invoice helper (createPendingArchivePurchase) was
// deleted 2026-07-05: the metered endpoint is disabled and no callers
// remained.

import type { PurchaseStore } from './queue.js';
import { markPaidAndEnqueue } from './purchase-settlement.js';

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
  // Shared core rolls back to pending on enqueue failure; rethrow so the
  // HTTP caller surfaces the failure instead of reporting success with
  // no job queued.
  const settled = await markPaidAndEnqueue({ purchases: opts.purchases, paymentHash });
  if (settled.status === 'enqueue-failed') throw settled.error;
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
