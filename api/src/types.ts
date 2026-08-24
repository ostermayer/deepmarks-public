import { z } from 'zod';
import type { ArchiveJob } from './archive-wire.js';
import { validateSafePublicHttpUrl } from './safe-url.js';

// ─── Archive job request ───────────────────────────────────────────────

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
  mirrorUrls: z.array(z.string().max(500).refine(
    (raw) => {
      try {
        const url = validateSafePublicHttpUrl(raw);
        return url.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'mirrorUrls must be public https Blossom server URLs' },
  )).max(8).optional(),
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
  /** User-requested backup Blossom servers. Worker validates again
   *  with DNS before making any outbound request. */
  mirrorUrls?: string[];
  /** Original bookmark save time, unix seconds. Archive lists use this
   *  so delayed archive jobs sort exactly like the bookmark list. */
  bookmarkSavedAt?: number;
  /** Original bookmark URL when this record queues a public rescue URL. */
  originalUrl?: string;
  /** Job category. 'webpage' (default), legacy 'youtube', 'video', or 'media'. The invoice
   *  settlement handler reads this to enqueue the right job shape. */
  kind?: 'webpage' | 'youtube' | 'video' | 'media' | 'file';
  /** YouTube 11-char video id when the video URL can be canonicalized. */
  videoId?: string;
  /** Stable source key for video metadata. YouTube uses yt:<id>;
   *  generic video pages use video:<sha256-normalized-url>. */
  videoContentKey?: string;
  /** Browser-extension fallback archive: sanitized, UTF-8 HTML captured
   *  from the user's current tab and base64-encoded before enqueue.
   *  This is private-only and cleared from the purchase row after the
   *  queue receives its copy. */
  capturedHtmlBase64?: string;
  capturedTitle?: string;
  capturedContentType?: string;
  capturedAt?: number;
  captureSource?: 'browser-extension';
}

/** The Box A ⇄ Box B wire shapes (ArchiveJob, ArchiveFileRecord,
 *  ArchiveDeleteJob) live in the generated archive-wire module — edit
 *  packages/archive-wire/archive-wire.ts, never the copy. Re-exported
 *  here so the rest of the api keeps importing them from types.js. */
export type { ArchiveJob, ArchiveFileRecord } from './archive-wire.js';

/** Non-secret archive job metadata retained after enqueue. Derived from
 *  ArchiveJob so the two can't drift: everything except the sensitive /
 *  oversized fields (archiveKey — scrubbed from the purchase row before
 *  the callback validates ownership/URL/tier against this record — plus
 *  attempts and the capturedHtml* payload, which must not sit in Redis
 *  for 30 days), with the settled price added. */
export type ArchiveJobMetadata = Pick<
  ArchiveJob,
  | 'jobId' | 'paymentHash' | 'ownerPubkey' | 'url' | 'eventId' | 'tier'
  | 'mirrorUrls' | 'enqueuedAt' | 'bookmarkSavedAt' | 'originalUrl'
  | 'kind' | 'videoId' | 'videoContentKey'
> & { amountSats?: number };

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
