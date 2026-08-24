// /archive/* — lifetime archive enqueue, legacy purchase guard, status
// polling, and the worker callback that records terminal job
// state (success or final failure).

import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Redis } from 'ioredis';

import {
  enqueueLifetimeArchive,
} from '../archive-purchase.js';
import {
  claimDefaultArchiveJob,
  claimPendingArchiveJob,
  releaseDefaultArchiveJob,
  releasePendingArchiveJob,
} from '../archive-dedupe.js';
import { createLifetimeArchiveJobId } from '../archive-purchase.js';
import { validateSafePublicHttpUrl } from '../safe-url.js';
import { YOUTUBE_VIDEO_ID_RE } from '../youtube-id.js';
import { publicWebUrl } from '../frontend-url.js';
import { normalizeMirrorUrls } from '../mirror-urls.js';
import { addArchiveRef } from '../archive-refcount.js';
import { rescueArchiveFailure } from '../archive-rescue.js';
import { maybeSubmitToSavePageNow } from '../wayback-spn.js';
import {
  archiveFailureMessage,
  classifyArchiveFailureReason,
  clearArchiveFailure,
  getRecentArchiveFailure,
  isPermanentArchiveFailureReason,
  isYoutubeBotWallError,
  recordArchiveFailure,
  shouldAlertArchiveFailure,
} from '../archive-failures.js';
import { queueAlertDigest, queueArchiveSummary } from '../llm-enrichment.js';
import type { Deps } from '../route-deps.js';
import type { ArchiveFileRecord, ArchiveJobMetadata, PurchaseRecord } from '../types.js';

const ARCHIVE_REPAIR_JOB_PREFIX = 'dm:archive-repair:job:';
const ARCHIVE_REPAIR_MARKER_PREFIX = 'dm:archive-repair:primary-missing:';
const ARCHIVE_REPAIR_TTL_SECONDS = 60 * 60 * 24 * 30;

/** BUD-04 mirror fanout result — `url` is the mirror server base. */
const MirrorResultSchema = z.object({
  url: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional(),
});

const ArchiveFileSchema = z.object({
  role: z.enum(['html', 'pdf', 'file', 'media']),
  blobHash: z.string().regex(/^[0-9a-f]{64}$/),
  url: z.string().max(2000),
  source: z.enum(['wayback', 'rendered', 'file']).optional(),
  contentType: z.string().trim().max(200).optional(),
  fileName: z.string().trim().max(255).optional(),
  thumbHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  mirrors: z.array(MirrorResultSchema).optional(),
});

const ArchiveCallbackSchema = z.object({
  jobId: z.string().min(1),
  status: z.enum(['ok', 'failed']),
  // Success fields
  blobHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  source: z.enum(['wayback', 'rendered', 'file']).optional(),
  tier: z.enum(['private', 'public']).optional(),
  ownerPubkey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  url: z.string().max(2000).optional(),
  /** Viewport-screenshot blob hash. Public-tier only — the worker
   *  skips screenshot upload for private archives so its bytes don't
   *  leak page content. */
  thumbHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  thumbSize: z.number().int().positive().optional(),
  /** BUD-04 mirror fanout results from archive-worker. The primary
   *  Blossom upload already succeeded before callback. */
  mirrors: z.array(MirrorResultSchema).optional(),
  // Video-archive extras. Worker sets these when kind='video' so
  // the user's archive list can render "Title — Channel" without an
  // extra round-trip from the frontend.
  kind: z.enum(['webpage', 'youtube', 'video', 'media', 'file']).optional(),
  contentType: z.string().trim().max(200).optional(),
  fileName: z.string().trim().max(255).optional(),
  videoId: z.string().regex(YOUTUBE_VIDEO_ID_RE).optional(),
  videoContentKey: z.string().regex(/^(yt:[a-zA-Z0-9_-]{11}|video:[0-9a-f]{64})$/).optional(),
  videoTitle: z.string().optional(),
  videoChannel: z.string().optional(),
  videoDurationSeconds: z.number().int().nonnegative().optional(),
  /** RFC 6381 MSE type when the media blob is fragmented MP4 — lets the
   *  client stream-play archived media instead of full-download first. */
  mseCodecs: z.string().max(120).optional(),
  files: z.array(ArchiveFileSchema).max(8).optional(),
  /** Original bookmark save time, unix seconds. When present, archive
   *  lists use this timestamp so archive ordering mirrors bookmark
   *  ordering even if the worker completes much later. */
  bookmarkSavedAt: z.number().int().positive().optional(),
  // Failure fields
  error: z.string().optional(),
  errorCategory: z.enum(['retryable', 'permanent']).optional(),
  /** Structured code from the worker's own error classes ('tweet_deleted',
   *  'anti_bot_wall', …) — preferred over message-string sniffing when
   *  classifying the failure reason. */
  errorCode: z.string().max(64).optional(),
  paymentHash: z.string().optional(),
});

const MAX_BROWSER_CAPTURE_BYTES = 5 * 1024 * 1024;
const MAX_BROWSER_CAPTURE_BASE64_CHARS = Math.ceil(MAX_BROWSER_CAPTURE_BYTES / 3) * 4 + 4;
const BrowserCaptureSchema = z.object({
  url: z.string().max(2000),
  eventId: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  archiveKey: z.string().regex(/^[A-Za-z0-9+/]{43}=?$/),
  htmlBase64: z.string().min(1).max(MAX_BROWSER_CAPTURE_BASE64_CHARS),
  title: z.string().trim().max(300).optional(),
  mirrorUrls: z.unknown().optional(),
  bookmarkSavedAt: z.unknown().optional(),
});

export function register(deps: Deps): void {
  const {
    app,
    purchases,
    redis,
    lifetimeStore,
    gateRateLimit,
    alerter,
    requireNip98,
    PUBLIC_BASE_URL,
  } = deps;

  // ─── Legacy metered archive guard ──────────────────────────────────
  // Disabled in production: archiving is now a lifetime-only capability.
  // Keep the route as a compatibility stop so old clients fail clearly
  // without creating a Lightning invoice.
  app.post('/archive/purchase', async (request, reply) => {
    if (!(await gateRateLimit(reply, 'archive-disabled-ip', request.ip, 60, 60))) return reply;
    return reply.status(402).send({
      error: 'archiving requires lifetime membership',
      upgradeUrl: publicWebUrl(PUBLIC_BASE_URL, '/app/upgrade'),
    });
  });

  // ── POST /archive/lifetime ─────────────────────────────────────────
  // Free-archive bypass for lifetime members. NIP-98 auth proves signer
  // possession; the auth pubkey must be stamped as a lifetime member
  // (either by BTCPay settlement or the reconcile/stamp admin endpoints).
  // On success the archive job is enqueued immediately — the response
  // shape matches the normal purchase response but with amountSats=0
  // and no invoice field, so the frontend can branch.
  app.post<{ Body: { url?: string; eventId?: string; tier?: string; archiveKey?: string; mirrorUrls?: unknown; bookmarkSavedAt?: unknown; dedupe?: unknown } }>(
    '/archive/lifetime',
    async (request, reply) => {
      const authCheck = await requireNip98(
        request,
        reply,
        `${PUBLIC_BASE_URL}/archive/lifetime`,
        'POST',
        { bindBody: true },
      );
      if (!authCheck) return;
      const pubkey = authCheck.pubkey;
      if (!(await lifetimeStore.isPaid(pubkey))) {
        return reply.status(402).send({ error: 'lifetime membership required — upgrade at /app/upgrade' });
      }
      const { url, eventId, tier, archiveKey, mirrorUrls, bookmarkSavedAt, dedupe: dedupeRequested } = request.body ?? {};
      if (!url || typeof url !== 'string') {
        return reply.status(400).send({ error: 'url required' });
      }
      // Validate tier + archiveKey shape (mirror of PurchaseRequestSchema).
      let normalizedTier: 'public' | 'private' | undefined;
      if (tier !== undefined) {
        if (tier !== 'public' && tier !== 'private') {
          return reply.status(400).send({ error: 'tier must be public or private' });
        }
        normalizedTier = tier;
      }
      let normalizedKey: string | undefined;
      if (normalizedTier === 'private') {
        if (typeof archiveKey !== 'string' || !/^[A-Za-z0-9+/]{43}=?$/.test(archiveKey)) {
          return reply.status(400).send({ error: 'archiveKey required (base64, 32 bytes) when tier=private' });
        }
        normalizedKey = archiveKey;
      }
      // Per-pubkey rate limit even for lifetime members: lifetime tier
      // is unmetered (no per-archive sats) but a stolen lifetime nsec
      // would otherwise let the attacker enqueue Playwright renders
      // forever. The bucket must still allow large one-time imports and
      // upgrade/backfill workflows; the worker drains the queue over time.
      if (!(await gateRateLimit(reply, 'archive-lifetime-pk', pubkey, 5000, 24 * 60 * 60, 'rate limit (lifetime)'))) return reply;
      // SSRF check at the gate too, even though the worker re-checks
      // with DNS — fail fast for obviously bad input.
      try {
        validateSafePublicHttpUrl(url);
      } catch {
        return reply.status(400).send({ error: 'url must be a public http(s) URL' });
      }
      const normalizedMirrorUrls = normalizeMirrorUrls(mirrorUrls);
      if (!normalizedMirrorUrls.ok) {
        return reply.status(400).send({ error: normalizedMirrorUrls.error });
      }
      const normalizedBookmarkSavedAt = normalizeBookmarkSavedAt(bookmarkSavedAt);
      if (bookmarkSavedAt !== undefined && normalizedBookmarkSavedAt === undefined) {
        return reply.status(400).send({ error: 'bookmarkSavedAt must be a valid unix timestamp' });
      }
      // A URL that recently failed terminally fails identically on immediate
      // re-enqueue. Permanent reasons (page gone, too large) are suppressed
      // for 30 days; retryable reasons get an escalating cooldown
      // (archiveFailureReenqueueWindowSeconds). The permanent-only version
      // of this gate stopped the 2026-07-17 duplicate-job loop but left
      // retryable failures ungated — so on 2026-08-21, with Wayback down and
      // its fallback unable to rescue dead URLs, a client backfill re-minted
      // a fresh MAX_ATTEMPTS job every ~14 minutes per failing URL until the
      // SLA failure spike paged the uptime alerter. Private tier is gated
      // too (round 2 of the same incident: the loop's URL was a PRIVATE
      // bookmark, and the old "explicit private stays allowed" exemption
      // predates the client's automated private/missing-key retries — which
      // mint a fresh archiveKey per duplicate, the 2026-07-17 failure mode).
      // Genuinely blocked private pages have /archive/browser-capture as the
      // escape hatch. The `queued:` jobId prefix keeps old clients on their
      // "already queued / skipped" path instead of surfacing an error.
      {
        const recentFailure = await getRecentArchiveFailure(redis, pubkey, url);
        if (recentFailure) {
          app.log.info(
            {
              url,
              user: pubkey,
              tier: normalizedTier,
              reason: recentFailure.reason,
              failedAt: recentFailure.failedAt,
              consecutiveFailures: recentFailure.consecutiveFailures,
            },
            'lifetime archive enqueue skipped — recent terminal failure',
          );
          const jobId = isPermanentArchiveFailureReason(recentFailure.reason)
            ? 'queued:permanent-failure'
            : 'queued:recent-failure';
          return { paymentHash: jobId, amountSats: 0, invoice: '', jobId };
        }
      }
      const dedupe = dedupeRequested === true && normalizedTier !== 'private'
        ? await claimDefaultArchiveJob(redis, pubkey, url)
        : null;
      if (dedupe && !dedupe.claimed) {
        return { paymentHash: dedupe.jobId, amountSats: 0, invoice: '', jobId: dedupe.jobId };
      }
      // Private tier used to bypass every dedupe on purpose ("explicit
      // user-initiated") — until a looping client backfill minted 40-58
      // duplicate jobs per URL (2026-07-17, 88% of a 20.5k queue), each
      // with a FRESH archiveKey, so the copies weren't even mutually
      // decryptable. While a private job for this owner+URL is queued or
      // in flight, further submissions get the `queued:` sentinel (old
      // clients already treat that prefix as already-queued/skipped)
      // rather than binding the client's newest key to an old job or
      // minting another copy. Released by the terminal callback.
      let pendingJobId: string | null = null;
      if (normalizedTier === 'private') {
        const jobId = createLifetimeArchiveJobId();
        const claim = await claimPendingArchiveJob(redis, 'lifetime', pubkey, url, jobId);
        if (!claim.claimed) {
          app.log.info(
            { url, user: pubkey, pendingJobId: claim.existingJobId },
            'private lifetime archive enqueue coalesced — job already pending',
          );
          const sentinel = 'queued:already-pending';
          return { paymentHash: sentinel, amountSats: 0, invoice: '', jobId: sentinel };
        }
        pendingJobId = jobId;
      }
      let result;
      try {
        result = await enqueueLifetimeArchive({
          purchases,
          url,
          userPubkey: pubkey,
          paymentHash: dedupe?.jobId ?? pendingJobId ?? undefined,
          eventId,
          tier: normalizedTier,
          archiveKey: normalizedKey,
          mirrorUrls: normalizedMirrorUrls.urls,
          bookmarkSavedAt: normalizedBookmarkSavedAt,
        });
      } catch (err) {
        if (dedupe) await releaseDefaultArchiveJob(redis, pubkey, url, dedupe.jobId).catch(() => undefined);
        if (pendingJobId) await releasePendingArchiveJob(redis, 'lifetime', pubkey, url, pendingJobId).catch(() => undefined);
        throw err;
      }
      app.log.info(
        { paymentHash: result.paymentHash, url, user: pubkey },
        'lifetime archive enqueued (free)',
      );
      // Best-effort: also ask the Internet Archive to capture this public page,
      // so a permanent Wayback snapshot exists even if our own render is later
      // bot-walled (the rescue pass already consults Wayback). Public webpages
      // only — never private/encrypted archives. Inert unless WAYBACK_SPN_ENABLED.
      if (normalizedTier !== 'private') {
        void maybeSubmitToSavePageNow(redis, url, { logger: app.log, trigger: 'enqueue' });
      }
      return { ...result, invoice: '', jobId: result.paymentHash };
    },
  );

  // ── POST /archive/browser-capture ──────────────────────────────────
  // Browser-extension fallback for pages that block the server worker
  // but are already visible in the user's tab. The payload is always
  // private: it can contain a personalized or signed-in view.
  app.post<{ Body: unknown }>(
    '/archive/browser-capture',
    { bodyLimit: MAX_BROWSER_CAPTURE_BASE64_CHARS + 20_000 },
    async (request, reply) => {
      const authCheck = await requireNip98(
        request,
        reply,
        `${PUBLIC_BASE_URL}/archive/browser-capture`,
        'POST',
        { bindBody: true },
      );
      if (!authCheck) return;
      const pubkey = authCheck.pubkey;
      if (!(await lifetimeStore.isPaid(pubkey))) {
        return reply.status(402).send({ error: 'lifetime membership required — upgrade at /app/upgrade' });
      }

      const parsed = BrowserCaptureSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid browser capture payload' });
      }
      const body = parsed.data;

      if (!(await gateRateLimit(reply, 'archive-browser-capture-pk', pubkey, 500, 24 * 60 * 60, 'rate limit (browser capture)'))) return reply;

      try {
        validateSafePublicHttpUrl(body.url);
      } catch {
        return reply.status(400).send({ error: 'url must be a public http(s) URL' });
      }

      const decoded = decodeBrowserCapture(body.htmlBase64);
      if (!decoded.ok) {
        return reply.status(400).send({ error: decoded.error });
      }

      const normalizedMirrorUrls = normalizeMirrorUrls(body.mirrorUrls);
      if (!normalizedMirrorUrls.ok) {
        return reply.status(400).send({ error: normalizedMirrorUrls.error });
      }
      const normalizedBookmarkSavedAt = normalizeBookmarkSavedAt(body.bookmarkSavedAt);
      if (body.bookmarkSavedAt !== undefined && normalizedBookmarkSavedAt === undefined) {
        return reply.status(400).send({ error: 'bookmarkSavedAt must be a valid unix timestamp' });
      }

      const result = await enqueueLifetimeArchive({
        purchases,
        url: body.url,
        userPubkey: pubkey,
        eventId: body.eventId,
        tier: 'private',
        archiveKey: body.archiveKey,
        mirrorUrls: normalizedMirrorUrls.urls,
        bookmarkSavedAt: normalizedBookmarkSavedAt,
        capturedHtmlBase64: decoded.base64,
        capturedTitle: body.title,
        capturedContentType: 'text/html; charset=utf-8',
        capturedAt: Math.floor(Date.now() / 1000),
        captureSource: 'browser-extension',
      });

      app.log.info(
        { paymentHash: result.paymentHash, url: body.url, user: pubkey, bytes: decoded.bytes },
        'browser-captured archive enqueued (private)',
      );
      return { ...result, invoice: '', jobId: result.paymentHash };
    },
  );

  app.get<{ Params: { hash: string } }>(
    '/archive/status/:hash',
    async (request, reply) => {
      const { hash } = request.params;
      // Real Lightning payment hashes are 64 hex chars; direct-enqueued
      // jobs use `lifetime:<32hex>` or `media:<32hex>` synthetic markers.
      if (!/^([0-9a-f]{64}|lifetime:[0-9a-f]{32}|media:[0-9a-f]{32})$/.test(hash)) {
        return reply.status(400).send({ error: 'invalid payment hash' });
      }
      const doneRaw = await redis.get(`dm:archive:done:${hash}`);
      if (doneRaw) {
        try {
          const done = JSON.parse(doneRaw) as {
            status?: 'ok' | 'failed';
            blobHash?: string;
            error?: string;
            errorCategory?: string;
          };
          if (done.status === 'ok') {
            return {
              jobId: hash,
              state: 'done',
              status: 'archived',
              blossomHash: done.blobHash,
              files: Array.isArray((done as { files?: unknown }).files) ? (done as { files: unknown }).files : undefined,
            };
          }
          if (done.status === 'failed') {
            const reason = classifyArchiveFailureReason(done.error, done.errorCategory);
            return {
              jobId: hash,
              state: 'failed',
              status: 'failed',
              reason,
              message: archiveFailureMessage(reason),
              error: done.error ?? 'archive job failed',
            };
          }
        } catch {
          // Corrupt terminal record: fall through to purchase state
          // rather than 500ing the user's polling loop.
        }
      }
      const rec = await purchases.get(hash);
      if (!rec) {
        // The purchase record has a 2h TTL but jobs can wait in the
        // queue far longer — polling clients got 404 for a job that
        // still existed (30-day metadata) and re-submitted duplicates
        // (2026-08-23 review). Fall back to the job metadata.
        const meta = await purchases.getArchiveJobMetadata(hash).catch(() => null);
        if (meta) {
          return { jobId: hash, state: 'queued', status: 'paid' };
        }
        return reply.status(404).send({ error: 'not found' });
      }
      const state = rec.status === 'pending'
        ? 'pending-payment'
        : rec.status === 'expired'
          ? 'failed'
          : 'queued';
      return {
        jobId: hash,
        state,
        // Compatibility for older extension builds that read `status`.
        status: rec.status,
        paidAt: rec.paidAt,
        amountSats: rec.amountSats,
        url: rec.url,
        error: rec.status === 'expired' ? 'archive request expired' : undefined,
      };
    },
  );

  // ═══════════════════════════════════════════════════════════════════
  // Archive worker callback (Box B → Box A)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Archive worker calls this after every terminal job state (success
   * or final failure). On success: record the archive in the user's
   * account and record the worker's BUD-04 mirror fanout results. On
   * failure: credit only legacy metered purchases that actually paid sats.
   *
   * Auth: HMAC-SHA256 over `${timestamp}|${rawBody}` keyed by the shared
   * worker secret, sent in `X-Worker-Signature`. Timestamp is in
   * `X-Worker-Timestamp` and must be within 5 minutes of server time.
   * Each signature is single-use (Redis dedup, 10 min TTL) so a leaked
   * header can't be replayed even within the freshness window.
   */
  app.post('/archive/callback', async (request, reply) => {
    const sharedSecret = process.env.WORKER_CALLBACK_SECRET;
    if (!sharedSecret) {
      return reply.status(503).send({ error: 'worker callback not configured' });
    }
    const tsRaw = request.headers['x-worker-timestamp'];
    const sigRaw = request.headers['x-worker-signature'];
    const ts = Number(Array.isArray(tsRaw) ? tsRaw[0] : tsRaw);
    const sig = String(Array.isArray(sigRaw) ? sigRaw[0] : sigRaw ?? '');
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) {
      return reply.status(401).send({ error: 'stale or missing worker timestamp' });
    }
    const raw = (request as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const expected = createHmac('sha256', sharedSecret)
      .update(String(ts))
      .update('|')
      .update(raw)
      .digest('hex');
    let sigBuf: Buffer;
    let expBuf: Buffer;
    try {
      sigBuf = Buffer.from(sig, 'hex');
      expBuf = Buffer.from(expected, 'hex');
    } catch {
      return reply.status(401).send({ error: 'malformed signature' });
    }
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return reply.status(401).send({ error: 'bad worker signature' });
    }
    // Single-use within the freshness window — blocks header replay.
    const dedup = await redis.set(`dm:archive-cb:${sig}`, '1', 'EX', 600, 'NX');
    if (dedup !== 'OK') {
      return reply.status(401).send({ error: 'callback replay rejected' });
    }

    // Liveness ping for the operator dashboard — stamp the last time
    // we saw a valid callback so /admin/dashboard can tell whether
    // Box B is still talking to us.
    await redis.set('dm:archive-worker:last-callback', String(Date.now())).catch(() => undefined);

    const parsed = ArchiveCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid payload' });
    }
    const payload = parsed.data;

    if (payload.status === 'ok') {
      if (!payload.blobHash || !payload.ownerPubkey || !payload.url || !payload.tier) {
        return reply.status(400).send({ error: 'missing success fields' });
      }

      const completedAt = Math.floor(Date.now() / 1000);
      const purchase = await purchases.get(payload.jobId).catch(() => null);
      const jobMetadata = await purchases.getArchiveJobMetadata(payload.jobId).catch(() => null);
      const activeMetadata = jobMetadata || purchase
        ? null
        : await purchases.findActiveArchiveJobMetadata(payload.jobId).catch(() => null);
      const expectedJob = jobMetadata ?? metadataFromPurchase(purchase) ?? activeMetadata;
      if (!expectedJob) {
        app.log.warn(
          { jobId: payload.jobId, owner: payload.ownerPubkey, url: payload.url },
          'archive success callback for unknown jobId',
        );
        return reply.status(404).send({ error: 'unknown jobId' });
      }
      const mismatch = archiveSuccessMismatch(payload, expectedJob);
      if (mismatch) {
        app.log.warn(
          {
            jobId: payload.jobId,
            reason: mismatch,
            claimedOwner: payload.ownerPubkey,
            expectedOwner: expectedJob.ownerPubkey,
            claimedUrl: payload.url,
            expectedUrl: expectedJob.url,
            claimedTier: payload.tier,
            expectedTier: expectedJob.tier,
          },
          'archive success callback metadata mismatch',
        );
        void alerter.alert({
          severity: 'critical',
          key: 'archive-callback-success-mismatch',
          subject: 'archive callback success payload mismatch',
          body: `An /archive/callback success request authenticated successfully (HMAC valid) but did not match the original queued job metadata.\n\nReason: ${mismatch}\nJob: ${payload.jobId}\nClaimed owner: ${payload.ownerPubkey}\nExpected owner: ${expectedJob.ownerPubkey}\nClaimed URL: ${payload.url}\nExpected URL: ${expectedJob.url}`,
        });
        return reply.status(403).send({ error: 'archive callback metadata mismatch' });
      }
      const completedAlready = await redis.exists(`dm:archive-completed:${payload.jobId}`);
      if (completedAlready) {
        app.log.info(
          { jobId: payload.jobId, hash: payload.blobHash },
          'duplicate archive success callback ignored',
        );
        return { ok: true, duplicate: true };
      }
      const bookmarkSavedAt = normalizeBookmarkSavedAt(payload.bookmarkSavedAt ?? expectedJob.bookmarkSavedAt);
      const files = archiveFilesFromCallback(payload);
      const originalUrl = expectedJob.originalUrl && expectedJob.originalUrl !== payload.url
        ? expectedJob.originalUrl
        : undefined;

      // Record the archive on the user's account. This Redis hash is
      // the account archive index consumed by the app and API routes.
      const archiveRecord = {
        jobId: payload.jobId,
        ownerPubkey: payload.ownerPubkey,
        url: payload.url,
        originalUrl,
        blobHash: payload.blobHash,
        source: payload.source,
        tier: payload.tier,
        // Public/mobile archive jobs can finish minutes or days after
        // the bookmark was created. Keep archive lists on the bookmark
        // timeline; completedAt preserves the worker completion time.
        archivedAt: bookmarkSavedAt ?? completedAt,
        completedAt,
        bookmarkSavedAt,
        // Viewport-screenshot blob hash, public-tier only. UI layers
        // render <img src=https://blossom.deepmarks.org/<thumbHash>>
        // for an instant card-sized preview without fetching the full
        // archive HTML.
        thumbHash: payload.thumbHash,
        contentType: payload.contentType,
        fileName: payload.fileName,
        mirrors: payload.mirrors,
        // Media archives carry a title + channel so the user's
        // archive list renders "Title — Channel" rather than a bare
        // 11-char video id. Worker pulls these from yt-dlp's metadata
        // pass before the download starts.
        kind: payload.kind ?? 'webpage',
        videoId: payload.videoId,
        videoContentKey: payload.videoContentKey,
        videoTitle: payload.videoTitle,
        videoChannel: payload.videoChannel,
        videoDurationSeconds: payload.videoDurationSeconds,
        mseCodecs: payload.mseCodecs,
        files,
      };
      await redis.hset(
        `dm:archives:${payload.ownerPubkey}`,
        payload.blobHash,
        JSON.stringify(archiveRecord),
      );
      if (deps.llm.enabled) {
        void queueArchiveSummary(redis, {
          ownerPubkey: payload.ownerPubkey,
          blobHash: payload.blobHash,
          archive: {
            url: payload.url,
            title: payload.videoTitle,
            description: payload.videoChannel,
            kind: payload.kind ?? 'webpage',
            contentType: payload.contentType,
            fileName: payload.fileName,
            videoTitle: payload.videoTitle,
            videoChannel: payload.videoChannel,
          },
        }).catch((err) => {
          app.log.warn({ err, jobId: payload.jobId, hash: payload.blobHash }, 'archive LLM summary enqueue failed');
        });
      }
      await clearArchiveFailure(redis, payload.ownerPubkey, payload.url).catch((err) => {
        app.log.warn({ err, jobId: payload.jobId, url: payload.url }, 'archive failure cleanup failed');
      });
      if (originalUrl) {
        await clearArchiveFailure(redis, payload.ownerPubkey, originalUrl).catch((err) => {
          app.log.warn({ err, jobId: payload.jobId, url: originalUrl }, 'original archive failure cleanup failed');
        });
      }
      // Refcount the actual stored bytes so a future delete from this
      // user only tears down primary storage when no other user still
      // references the same blob. Private media archives use the blob
      // hash too: the bytes are encrypted with a per-user key, so a
      // source-level videoContentKey must not collapse distinct
      // ciphertext blobs.
      for (const file of files) {
        await addArchiveRef(redis, file.blobHash, payload.ownerPubkey);
      }
      const cleanedRepairHashes = await cleanupPrimaryMissingRepair(redis, {
        jobId: payload.jobId,
        ownerPubkey: payload.ownerPubkey,
        url: payload.url,
        replacementHash: payload.blobHash,
      }).catch((err) => {
        app.log.warn({ err, jobId: payload.jobId, hash: payload.blobHash }, 'archive repair cleanup failed');
        return 0;
      });
      if (cleanedRepairHashes > 0) {
        app.log.info(
          { jobId: payload.jobId, hash: payload.blobHash, oldHashesRemoved: cleanedRepairHashes },
          'archive repair old hashes removed',
        );
      }
      // Mark this jobId as terminally completed so any later 'failed'
      // callback (worker bug, retried delivery from a partitioned
      // worker) can't slip a refund past us. 30-day TTL covers any
      // realistic delivery window. This happens after the account
      // record write so a transient Redis error can still be retried.
      await redis.set(`dm:archive-completed:${payload.jobId}`, '1', 'EX', 60 * 60 * 24 * 30, 'NX');
      // Free the pending-archive claim so the owner can re-archive this
      // URL later without waiting out the 7-day TTL backstop.
      if (payload.ownerPubkey && payload.url) {
        await releasePendingArchiveJob(
          redis,
          payload.jobId.startsWith('media:') ? 'media' : 'lifetime',
          payload.ownerPubkey,
          payload.url,
          payload.jobId,
        ).catch(() => undefined);
      }
      const mirrors = payload.mirrors ?? [];
      const failedMirrors = mirrors.filter((m) => !m.ok);
      if (mirrors.length === 0) {
        app.log.warn(
          { jobId: payload.jobId, hash: payload.blobHash },
          'archive complete but no Blossom mirror fanout results were reported',
        );
      } else if (failedMirrors.length > 0) {
        // Log-only, never an operator email (2026-07-17 decision, replacing
        // the 07-08 zero-redundancy alert): mirror legs are OTHER people's
        // Blossom servers rejecting or timing out — the fanout only runs
        // after the primary upload is verified, so these results can never
        // indicate our own Blossom failing, and the worker's retry queue
        // re-attempts failed legs with backoff anyway (9-day live stats:
        // 1608 retries scheduled, 3 exhausted). Primary Blossom trouble
        // alerts via job failures + the blossom-primary uptime probe.
        app.log.warn(
          { jobId: payload.jobId, hash: payload.blobHash, failedMirrors },
          'archive complete with partial Blossom mirror fanout',
        );
      }
      app.log.info(
        {
          jobId: payload.jobId,
          hash: payload.blobHash,
          mirrorsOk: mirrors.filter((m) => m.ok).length,
          mirrorsFailed: failedMirrors.length,
        },
        'archive complete',
      );

      return { ok: true };
    }

    // Failure path: mark/alert the terminal worker failure. Legacy
    // metered archives paid sats, so they still get an account credit.
    // Lifetime archive jobs have amountSats=0 and need no refund.
    if (!payload.ownerPubkey || !payload.paymentHash) {
      return reply.status(400).send({ error: 'missing failure fields' });
    }

    // Verify the (jobId/paymentHash, ownerPubkey) pair matches a real
    // purchase. Without this, the worker (or anyone who got hold of
    // the shared secret) could mint refund credits to any pubkey by
    // claiming an arbitrary jobId.
    const purchase = await purchases.get(payload.paymentHash);
    const jobMetadata = await purchases.getArchiveJobMetadata(payload.paymentHash).catch(() => null);
    const activeMetadata = jobMetadata || purchase
      ? null
      : await purchases.findActiveArchiveJobMetadata(payload.paymentHash).catch(() => null);
    const expectedJob = jobMetadata ?? metadataFromPurchase(purchase) ?? activeMetadata;
    if (!expectedJob) {
      app.log.warn(
        { jobId: payload.jobId, owner: payload.ownerPubkey },
        'archive callback for unknown jobId — refusing refund',
      );
      return reply.status(404).send({ error: 'unknown jobId' });
    }
    if (expectedJob.ownerPubkey !== payload.ownerPubkey) {
      app.log.warn(
        { jobId: payload.jobId, claimedOwner: payload.ownerPubkey, actualOwner: expectedJob.ownerPubkey },
        'archive callback ownerPubkey mismatch — refusing refund',
      );
      void alerter.alert({
        severity: 'critical',
        key: 'archive-callback-owner-mismatch',
        subject: 'archive callback claims wrong ownerPubkey — possible HMAC compromise',
        body: `An /archive/callback request authenticated successfully (HMAC valid) but claimed ownerPubkey=${payload.ownerPubkey} for a job actually owned by ${expectedJob.ownerPubkey}. Either the worker has a bug, the WORKER_CALLBACK_SECRET has leaked, or someone has guessed the HMAC. Investigate immediately.\n\nJob: ${payload.jobId}`,
      });
      return reply.status(403).send({ error: 'owner mismatch' });
    }
    // Terminal failure frees the pending-archive claim immediately — the
    // user should be able to retry the URL without waiting out the 7-day
    // TTL backstop. Value-matched, so a claim already re-taken by a newer
    // job is untouched.
    if (expectedJob.url) {
      await releasePendingArchiveJob(
        redis,
        payload.jobId.startsWith('media:') ? 'media' : 'lifetime',
        payload.ownerPubkey,
        expectedJob.url,
        payload.paymentHash,
      ).catch(() => undefined);
    }
    // Don't refund jobs that already shipped a successful archive.
    // The Purchase.status field tracks the *invoice* lifecycle (pending
    // → paid → enqueued → expired) — successful archive completion is
    // a separate marker dropped by the success path above. A buggy or
    // double-firing worker that posts {status:'failed'} after we
    // already recorded the archive would otherwise issue a refund on
    // top of the delivered archive.
    const completedAlready = await redis.exists(`dm:archive-completed:${payload.jobId}`);
    if (completedAlready) {
      app.log.warn(
        { jobId: payload.jobId, owner: payload.ownerPubkey },
        'archive callback claims failure on already-archived job — ignoring',
      );
      return { ok: true, refund: 'job-already-archived', sats: 0 };
    }
    if (purchase?.status === 'expired') {
      return { ok: true, refund: 'invoice-expired', sats: 0 };
    }

    const amountSats = purchase?.amountSats ?? expectedJob.amountSats ?? 0;
    if (amountSats > 0) {
      // Idempotency: refund credit at most once per jobId. Without this,
      // a successful HMAC + a future replay window collision could
      // double-credit. The marker key shares the purchase TTL window.
      const refundMarker = await redis.set(
        `dm:archive-refund:${payload.paymentHash}`,
        '1',
        'EX',
        60 * 60 * 24,
        'NX',
      );
      if (refundMarker !== 'OK') {
        app.log.info({ jobId: payload.jobId }, 'archive refund already issued — skipping');
        return { ok: true, refund: 'already-issued', sats: 0 };
      }
    }

    const failureReason = classifyArchiveFailureReason(payload.error, payload.errorCategory, payload.errorCode);
    // Rescue jobs (jobId rescue:*) keep alerting on purpose: while the
    // archiver is being tuned, their MAX_ATTEMPTS notices are the operator's
    // signal for which mirror/alternative sources are failing. The jobId
    // prefix in the alert makes them easy to tell apart.
    const isRescueJob = (payload.jobId ?? '').startsWith('rescue:');
    const alertOperator = shouldAlertArchiveFailure(failureReason, payload.error, expectedJob.kind, expectedJob.url);
    const failureLog = {
      jobId: payload.jobId,
      error: payload.error,
      category: payload.errorCategory,
      reason: failureReason,
      alertOperator,
      isRescueJob,
    };
    const failureMessage = amountSats > 0 ? 'archive failed; issuing refund credit' : 'lifetime archive failed';
    if (alertOperator) app.log.warn(failureLog, failureMessage);
    else app.log.info(failureLog, 'archive failed with expected page error');

    const failedAt = Math.floor(Date.now() / 1000);
    const failureRecord = {
      jobId: payload.jobId,
      ownerPubkey: payload.ownerPubkey,
      url: expectedJob.url,
      eventId: expectedJob.eventId,
      reason: failureReason,
      message: archiveFailureMessage(failureReason),
      error: payload.error,
      errorCategory: payload.errorCategory,
      errorCode: payload.errorCode,
      failedAt,
      bookmarkSavedAt: expectedJob.bookmarkSavedAt,
      tier: expectedJob.tier,
      kind: expectedJob.kind,
      mirrorUrls: expectedJob.mirrorUrls,
    };
    await recordArchiveFailure(redis, failureRecord).catch((err) => {
      app.log.warn({ err, jobId: payload.jobId, owner: payload.ownerPubkey }, 'archive failure record write failed');
    });
    // Wire the web-search candidate source and a logger into the rescue
    // pass. `Deps` names the search client `archiveRescueSearch` and has no
    // logger, so passing it raw left `deps.search`/`deps.logger` undefined —
    // silently disabling the entire searxng/archive.today search path and
    // all rescue observability.
    void rescueArchiveFailure(
      { ...deps, search: deps.archiveRescueSearch, logger: app.log },
      failureRecord,
    ).catch((err) => {
      app.log.warn({ err, jobId: payload.jobId, url: expectedJob.url }, 'archive rescue attempt failed');
    });

    // Best-effort Save Page Now for a public webpage we couldn't capture
    // ourselves (bot-wall, timeout): IA crawls from its own infra/IP and often
    // succeeds where our datacenter renderer is blocked, and a later rescue
    // pass then finds the snapshot. Skip media, "gone"/too-large outcomes, and
    // private/encrypted archives. Inert unless WAYBACK_SPN_ENABLED.
    const spnEligible = expectedJob.kind !== 'media' && expectedJob.kind !== 'video'
      && expectedJob.kind !== 'youtube' && expectedJob.tier !== 'private'
      && failureReason !== 'not-found' && failureReason !== 'too-large';
    if (spnEligible && expectedJob.url) {
      void maybeSubmitToSavePageNow(redis, expectedJob.url, { logger: app.log, trigger: 'failure' });
    }

    if (!alertOperator) {
      app.log.info(
        { jobId: payload.jobId, reason: failureReason, url: expectedJob.url },
        'archive failure recorded without operator alert',
      );
    }

    let credited = 0;
    if (amountSats > 0) {
      credited = await redis
        .hincrby(`dm:archive-credits:${payload.ownerPubkey}`, 'sats', amountSats)
        .catch(() => 0);
      app.log.info(
        { owner: payload.ownerPubkey, credits: credited, sats: amountSats },
        'archive refund credited to account',
      );
    }

    if (alertOperator) {
      // Operational visibility. Dedup key is stable so a burst of
      // failures (renderer broken, Blossom degraded) collapses to one
      // email per 10-min debounce window; the body carries the most
      // recent jobId/URL/error so we can pivot to logs from there.
      const subject = amountSats > 0
        ? 'legacy metered archive failed terminally — user credited'
        : 'lifetime archive failed terminally';
      const body = `An archive job hit MAX_ATTEMPTS.\n\nJob: ${payload.jobId}\nURL: ${expectedJob.url ?? '(unknown)'}\nOwner: ${payload.ownerPubkey}\nError: ${payload.error ?? '(none)'}\nCategory: ${payload.errorCategory ?? '(none)'}\nReason: ${failureReason}\nCredit: ${amountSats > 0 ? `${amountSats} sats credited to account` : 'none (lifetime archive job)'}.\n\nAudit trail: redis-cli LRANGE dm:archive:audit:${payload.jobId} 0 -1`;
      if (deps.llm.enabled) {
        void queueAlertDigest(redis, {
          severity: 'warning',
          key: 'archive-failed',
          subject,
          body,
        }).catch((err) => {
          app.log.warn({ err, jobId: payload.jobId }, 'archive failure LLM alert digest enqueue failed');
        });
      }
      void alerter.alert({
        severity: 'warning',
        key: 'archive-failed',
        subject,
        body,
      });
    }

    // Distinct, rate-limited alert when YouTube bot-detection trips — almost
    // always means the operator's yt-dlp cookies expired and need
    // re-exporting. Overrides the best-effort media-failure suppression (this
    // IS actionable), but is cooldown'd to one email per 12h via SET NX so a
    // backlog of videos can't spam.
    if (isYoutubeBotWallError(payload.error, expectedJob.url)) {
      const fresh = await redis
        .set('dm:alert:youtube-cookies', String(failedAt), 'EX', 43_200, 'NX')
        .catch(() => null);
      if (fresh) {
        void alerter.alert({
          severity: 'warning',
          key: 'youtube-cookies-expired',
          subject: 'YouTube cookies need refreshing',
          body: `YouTube archiving is failing with bot-detection ("Sign in to confirm you're not a bot"), which almost always means the yt-dlp cookies expired.\n\nExport a fresh cookies.txt from a logged-in YouTube session (use a burner account) and replace /opt/deepmarks-secrets/yt-cookies.txt on Box B, then recreate the archive-worker.\n\nExample failing job: ${payload.jobId}\nURL: ${expectedJob.url ?? '(unknown)'}\nError: ${payload.error ?? '(none)'}`,
        });
        app.log.warn({ jobId: payload.jobId }, 'youtube bot-wall — cookie-refresh alert sent');
      }
    }

    return {
      ok: true,
      refund: amountSats > 0 ? 'account-credit' : 'not-needed',
      sats: amountSats,
      credits: credited,
    };
  });
}

function normalizeBookmarkSavedAt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined;
  const now = Math.floor(Date.now() / 1000);
  if (value > now + 10 * 60) return undefined;
  return value;
}

async function cleanupPrimaryMissingRepair(
  redis: Redis,
  input: { jobId: string; ownerPubkey: string; url: string; replacementHash: string },
): Promise<number> {
  const jobRepairKey = `${ARCHIVE_REPAIR_JOB_PREFIX}${input.jobId}`;
  const markerKey = await redis.get(jobRepairKey);
  if (!markerKey?.startsWith(ARCHIVE_REPAIR_MARKER_PREFIX)) return 0;

  const raw = await redis.get(markerKey);
  if (!raw) return 0;

  let marker: unknown;
  try {
    marker = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!isRepairMarker(marker)) return 0;
  if (
    marker.jobId !== input.jobId ||
    marker.ownerPubkey !== input.ownerPubkey ||
    marker.url !== input.url
  ) {
    return 0;
  }

  const oldHashes = [...new Set(marker.oldBlobHashes)]
    .filter((hash) => hash !== input.replacementHash);
  if (oldHashes.length === 0) return 0;

  const archiveKey = `dm:archives:${input.ownerPubkey}`;
  const pipeline = redis.multi();
  pipeline.hdel(archiveKey, ...oldHashes);
  for (const oldHash of oldHashes) {
    pipeline.srem(`dm:archive-refs:${oldHash}`, input.ownerPubkey);
  }
  pipeline.set(
    markerKey,
    JSON.stringify({
      ...marker,
      status: 'cleaned',
      cleanedAt: Math.floor(Date.now() / 1000),
      replacementHash: input.replacementHash,
    }),
    'EX',
    ARCHIVE_REPAIR_TTL_SECONDS,
  );
  pipeline.del(jobRepairKey);
  const results = await pipeline.exec();
  const err = results?.find(([entryErr]) => entryErr)?.[0];
  if (err) throw err;
  return oldHashes.length;
}

function isRepairMarker(value: unknown): value is {
  jobId: string;
  ownerPubkey: string;
  url: string;
  oldBlobHashes: string[];
} {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Record<string, unknown>;
  return (
    typeof marker.jobId === 'string' &&
    typeof marker.ownerPubkey === 'string' &&
    /^[0-9a-f]{64}$/.test(marker.ownerPubkey) &&
    typeof marker.url === 'string' &&
    Array.isArray(marker.oldBlobHashes) &&
    marker.oldBlobHashes.every((hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash))
  );
}

function archiveFilesFromCallback(payload: z.infer<typeof ArchiveCallbackSchema>): ArchiveFileRecord[] {
  if (!payload.blobHash || !payload.url) return [];
  const files: ArchiveFileRecord[] = [];
  const seen = new Set<string>();
  const push = (file: ArchiveFileRecord): void => {
    if (!/^[0-9a-f]{64}$/.test(file.blobHash)) return;
    if (seen.has(file.blobHash)) return;
    seen.add(file.blobHash);
    files.push(file);
  };

  push({
    role: archiveFileRoleFromPayload(payload.kind, payload.contentType),
    blobHash: payload.blobHash,
    url: payload.url,
    source: payload.source,
    contentType: payload.contentType,
    fileName: payload.fileName,
    thumbHash: payload.thumbHash,
    mirrors: payload.mirrors,
  });

  for (const file of payload.files ?? []) {
    push({
      role: file.role,
      blobHash: file.blobHash,
      url: file.url || payload.url,
      source: file.source,
      contentType: file.contentType,
      fileName: file.fileName,
      thumbHash: file.thumbHash,
      mirrors: file.mirrors,
    });
  }

  return files;
}

function archiveFileRoleFromPayload(
  kind: z.infer<typeof ArchiveCallbackSchema>['kind'],
  contentType: string | undefined,
): ArchiveFileRecord['role'] {
  const normalized = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (normalized === 'application/pdf') return 'pdf';
  if (kind === 'video' || kind === 'youtube' || kind === 'media' || normalized.startsWith('video/') || normalized.startsWith('audio/')) {
    return 'media';
  }
  if (kind === 'file') return 'file';
  return 'html';
}

function decodeBrowserCapture(input: string):
  | { ok: true; base64: string; bytes: number }
  | { ok: false; error: string } {
  const normalized = input.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    return { ok: false, error: 'htmlBase64 must be valid base64' };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(normalized, 'base64');
  } catch {
    return { ok: false, error: 'htmlBase64 must be valid base64' };
  }
  if (bytes.byteLength <= 0) {
    return { ok: false, error: 'browser capture is empty' };
  }
  if (bytes.byteLength > MAX_BROWSER_CAPTURE_BYTES) {
    return { ok: false, error: `browser capture exceeds ${Math.floor(MAX_BROWSER_CAPTURE_BYTES / 1024 / 1024)} MB` };
  }
  const canonical = bytes.toString('base64').replace(/=+$/, '');
  if (canonical !== normalized.replace(/=+$/, '')) {
    return { ok: false, error: 'htmlBase64 must be valid base64' };
  }
  const head = bytes.subarray(0, Math.min(bytes.byteLength, 16_384)).toString('utf8').toLowerCase();
  if (!head.includes('<html') && !head.includes('<!doctype')) {
    return { ok: false, error: 'browser capture must be an HTML document' };
  }
  return { ok: true, base64: bytes.toString('base64'), bytes: bytes.byteLength };
}

function metadataFromPurchase(purchase: PurchaseRecord | null): ArchiveJobMetadata | null {
  if (!purchase) return null;
  return {
    jobId: purchase.paymentHash,
    paymentHash: purchase.paymentHash,
    ownerPubkey: purchase.userPubkey,
    url: purchase.url,
    eventId: purchase.eventId,
    tier: expectedTier(purchase),
    mirrorUrls: purchase.mirrorUrls,
    enqueuedAt: purchase.paidAt ?? purchase.createdAt,
    bookmarkSavedAt: purchase.bookmarkSavedAt,
    originalUrl: purchase.originalUrl,
    kind: purchase.kind,
    videoId: purchase.videoId,
    videoContentKey: purchase.videoContentKey,
    amountSats: purchase.amountSats,
  };
}

function expectedTier(record: Pick<PurchaseRecord, 'kind' | 'tier'>): 'public' | 'private' {
  return record.kind === 'youtube' || record.kind === 'video' || record.kind === 'media'
    ? 'private'
    : (record.tier ?? 'public');
}

function archiveSuccessMismatch(
  payload: z.infer<typeof ArchiveCallbackSchema>,
  expected: ArchiveJobMetadata,
): string | null {
  if (payload.ownerPubkey !== expected.ownerPubkey) return 'ownerPubkey';
  if (payload.url !== expected.url) return 'url';
  if (payload.tier !== expected.tier) return 'tier';
  const expectedKind = expected.kind ?? 'webpage';
  const payloadKind = payload.kind ?? 'webpage';
  // A normal webpage job can resolve to a direct PDF/file archive when
  // the URL or response headers identify a PDF. That is worker-side
  // type detection, not a callback mismatch.
  if (expectedKind === 'webpage' && payloadKind === 'file') return null;
  if (payloadKind !== expectedKind) return 'kind';
  if (expected.videoId && payload.videoId !== expected.videoId) return 'videoId';
  if (expected.videoContentKey && payload.videoContentKey !== expected.videoContentKey) {
    return 'videoContentKey';
  }
  return null;
}
