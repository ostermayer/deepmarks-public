import { z } from 'zod';
import { validateSafePublicHttpUrl } from './safe-url.js';

// ─── Archive purchase ──────────────────────────────────────────────────

export const PurchaseRequestSchema = z.object({
  // SSRF guard: reject file://, javascript:, internal IPs, link-local,
  // RFC1918, loopback, single-label hosts. Worker re-checks after DNS.
  url: z.string().max(2000).refine(
    (raw) => { try { validateSafePublicHttpUrl(raw); return true; } catch { return false; } },
    { message: 'url must be a public http(s) URL' },
  ),
  eventId: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  userPubkey: z.string().regex(/^[0-9a-f]{64}$/),
  // Archive tier — 'public' = unencrypted HTML on Blossom (default),
  // 'private' = AES-256-GCM encrypted with archiveKey before upload.
  // The plaintext key arrives here (and on the server, briefly) during
  // job creation; the worker zeros it from memory after encryption,
  // and we never persist it — the client is responsible for storing
  // the wrapped key so they can decrypt later.
  tier: z.enum(['public', 'private']).optional(),
  // 32-byte AES-256 key, base64. Required when tier === 'private',
  // ignored otherwise. ~44 chars unpadded, 44 with '=' padding.
  archiveKey: z.string().regex(/^[A-Za-z0-9+/]{43}=?$/).optional(),
}).refine(
  (val) => val.tier !== 'private' || !!val.archiveKey,
  { message: 'archiveKey required when tier is private', path: ['archiveKey'] },
);

export type PurchaseRequest = z.infer<typeof PurchaseRequestSchema>;

export interface PurchaseRecord {
  url: string;
  eventId?: string;
  userPubkey: string;
  paymentHash: string;
  invoice: string;
  amountSats: number;
  status: 'pending' | 'paid' | 'enqueued' | 'expired';
  createdAt: number;
  paidAt?: number;
  /** 'public' | 'private' — controls whether the worker encrypts the
   *  rendered HTML before upload to Blossom. Defaults to 'public'. */
  tier?: 'public' | 'private';
  /** Base64 32-byte AES key for tier='private'. Held in Redis only
   *  until the worker has consumed it (~1-3 min), then cleared. */
  archiveKey?: string;
}

/** On-the-wire job shape pushed onto dm:archive:queue. Matches
 *  archive-worker/src/queue.ts:ArchiveJob exactly — schema drift
 *  between the two has already cost us a queue's worth of stuck jobs.
 *  When this changes, both sides change in the same commit. */
export interface ArchiveJob {
  /** Identity used by the worker callback path. We use paymentHash
   *  verbatim — it's already unique per archive purchase and lets the
   *  proxy correlate the callback back to a refund without an extra
   *  lookup table. */
  jobId: string;
  paymentHash: string;
  /** Renamed from userPubkey to match the worker's vocabulary. */
  ownerPubkey: string;
  url: string;
  eventId?: string;
  /** Default 'public' if the caller didn't specify. */
  tier: 'public' | 'private';
  /** Base64 AES-256 key (32 bytes). Null for public-tier jobs. */
  archiveKey: string | null;
  /** Retry counter, 0 on first enqueue. The worker increments on requeue. */
  attempts: number;
  /** When this job was first put on the queue (unix seconds). */
  enqueuedAt: number;
}

// ─── LNURL-pay + NIP-57 zaps ──────────────────────────────────────────

/**
 * A NIP-57 zap request (kind 9734). Don't trust until validateZapRequest().
 */
export interface ZapRequestEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: 9734;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * What we store in Redis while waiting for a zap invoice to settle.
 * On settlement we use this to build and publish the kind:9735 receipt.
 */
export interface PendingZap {
  paymentHash: string;
  amountMsat: number;
  invoice: string;                 // BOLT-11
  /** Exact raw JSON string used to compute the description hash. */
  rawZapRequest: string;
  /** Parsed zap request, for tag extraction. */
  zapRequest: ZapRequestEvent;
  /** Relays to publish the receipt to, from the zap request's `relays` tag. */
  relays: string[];
  createdAt: number;
}
