// /add-on/youtube-archive/* — per-video YouTube archive purchase flow.
//
// Add-on, not a core feature: archiving a video involves yt-dlp +
// ffmpeg + materially larger object storage per archive than a
// webpage snapshot, so it's metered at 150k sats per video regardless
// of lifetime membership.
//
// Flow:
//   1. Client POSTs the YouTube URL.
//   2. Server canonicalises it to a video ID, creates a 150k-sat
//      BOLT-11 invoice, and stores a PurchaseRecord with kind='youtube'.
//   3. Client pays via Lightning.
//   4. invoice-handler.ts (Voltage subscription) sees the settlement
//      and calls enqueueArchiveJob(record), which sets kind='youtube'
//      on the ArchiveJob so the worker takes the yt-dlp branch.
//   5. Box B worker downloads at ≤720p, encrypts client-side with
//      AES-256-GCM, uploads to the ciphertext bucket (private always),
//      and posts /archive/callback with the title/channel metadata.
//   6. Callback writes the archive record and refcounts yt:<videoId>
//      so future buyers of the same video skip the download and just
//      record a new reference to the existing ciphertext blob.

import { parseYoutubeVideoId, canonicalYoutubeUrl, videoContentKey } from '../youtube.js';
import { getArchiveRefCount } from '../archive-refcount.js';
import { createYoutubeArchiveInvoice, YOUTUBE_ARCHIVE_COST_SATS, INVOICE_EXPIRY_SECONDS } from '../voltage.js';
import type { Deps } from '../route-deps.js';

export function register(deps: Deps): void {
  const {
    app, lnd, purchases, redis, requireNip98, rateLimit, PUBLIC_BASE_URL,
  } = deps;

  // POST /add-on/youtube-archive/invoice
  // Body: { url: string, archiveKey: string (base64, 32 bytes) }
  // Returns: { paymentHash, invoice, amountSats, videoId, expiresInSeconds,
  //            alreadyArchived: boolean }
  //
  // `alreadyArchived` is purely informational — the client may show
  // "another user has already archived this video; your purchase will
  // be served from the existing copy" so the user understands the dedup.
  // Each user still pays — the price covers their own permanent
  // reference to the blob, not just the download.
  app.post<{ Body: { url?: string; archiveKey?: string } }>(
    '/add-on/youtube-archive/invoice',
    async (request, reply) => {
      const auth = await requireNip98(
        request,
        reply,
        `${PUBLIC_BASE_URL}/add-on/youtube-archive/invoice`,
        'POST',
        { bindBody: true },
      );
      if (!auth) return;

      // Per-pubkey rate limit so the URL parser + invoice issuance can't
      // be hammered into wallet-creation territory.
      const gate = await rateLimit('yt-archive-invoice', auth.pubkey, 30, 60);
      if (!gate.ok) {
        reply.header('Retry-After', String(gate.retryAfter));
        return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
      }

      const { url, archiveKey } = request.body ?? {};
      if (typeof url !== 'string' || !url.trim()) {
        return reply.status(400).send({ error: 'url required' });
      }
      const videoId = parseYoutubeVideoId(url);
      if (!videoId) {
        return reply.status(400).send({ error: 'not a valid YouTube video URL' });
      }
      // YouTube archives are always private — caller must supply a
      // 32-byte AES key in base64. Frontend generates it client-side
      // and stores it in the user's NIP-51 archive-keys set, same way
      // private webpage archives work.
      if (typeof archiveKey !== 'string' || !/^[A-Za-z0-9+/]{43}=?$/.test(archiveKey)) {
        return reply.status(400).send({ error: 'archiveKey required (base64, 32 bytes)' });
      }

      if (!lnd) {
        return reply.status(503).send({ error: 'lightning not configured on this server' });
      }

      // Has anyone archived this video already? Pure informational —
      // we still create an invoice. The worker uses the same Redis key
      // to short-circuit the download on dedup hits.
      const existingRefs = await getArchiveRefCount(redis, videoContentKey(videoId));
      const alreadyArchived = existingRefs > 0;

      const { paymentHash, invoice } = await createYoutubeArchiveInvoice(lnd, videoId);
      await purchases.create({
        url: canonicalYoutubeUrl(videoId),
        userPubkey: auth.pubkey,
        paymentHash,
        invoice,
        amountSats: YOUTUBE_ARCHIVE_COST_SATS,
        status: 'pending',
        createdAt: Math.floor(Date.now() / 1000),
        tier: 'private',
        archiveKey,
        kind: 'youtube',
        videoId,
      });

      return {
        paymentHash,
        invoice,
        amountSats: YOUTUBE_ARCHIVE_COST_SATS,
        videoId,
        canonicalUrl: canonicalYoutubeUrl(videoId),
        expiresInSeconds: INVOICE_EXPIRY_SECONDS,
        alreadyArchived,
      };
    },
  );

  // GET /add-on/youtube-archive/status/:paymentHash
  // Lightweight poll target for the purchase UI. Returns the purchase
  // status + (if the worker has completed it) the metadata + blob hash.
  app.get<{ Params: { paymentHash: string } }>(
    '/add-on/youtube-archive/status/:paymentHash',
    async (request, reply) => {
      const paymentHash = request.params.paymentHash;
      // Two state sources: PurchaseRecord (pre-archive) and the
      // worker-callback record (post-archive).
      const purchase = await purchases.get(paymentHash);
      if (!purchase) {
        return reply.status(404).send({ error: 'unknown paymentHash' });
      }
      // Worker writes a done record under dm:archive:done:<jobId> with
      // a 24h TTL. If present, the archive is terminal (ok or failed).
      const doneRaw = await redis.get(`dm:archive:done:${paymentHash}`);
      let done: Record<string, unknown> | null = null;
      if (doneRaw) {
        try { done = JSON.parse(doneRaw) as Record<string, unknown>; }
        catch { done = null; }
      }
      return {
        paymentHash,
        status: purchase.status,
        amountSats: purchase.amountSats,
        videoId: purchase.videoId,
        canonicalUrl: purchase.url,
        done,
      };
    },
  );
}
