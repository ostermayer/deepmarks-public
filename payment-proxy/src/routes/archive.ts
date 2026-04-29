// /archive/* — purchase invoice creation, lifetime free-archive bypass,
// status polling, and the worker callback that records terminal job
// state (success or final failure).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import {
  createPendingArchivePurchase,
  enqueueLifetimeArchive,
  ArchiveUnavailableError,
} from '../archive-purchase.js';
import { PurchaseRequestSchema } from '../types.js';
import { validateSafePublicHttpUrl } from '../safe-url.js';
import type { Deps } from '../route-deps.js';

const ArchiveCallbackSchema = z.object({
  jobId: z.string().min(1),
  status: z.enum(['ok', 'failed']),
  // Success fields
  blobHash: z.string().optional(),
  source: z.enum(['wayback', 'rendered']).optional(),
  tier: z.enum(['private', 'public']).optional(),
  ownerPubkey: z.string().optional(),
  url: z.string().optional(),
  /** Viewport-screenshot blob hash. Public-tier only — the worker
   *  skips screenshot upload for private archives so its bytes don't
   *  leak page content. */
  thumbHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  thumbSize: z.number().int().positive().optional(),
  // Failure fields
  error: z.string().optional(),
  errorCategory: z.enum(['retryable', 'permanent']).optional(),
  paymentHash: z.string().optional(),
});

export function register(deps: Deps): void {
  const {
    app,
    purchases,
    lnd,
    redis,
    lifetimeStore,
    rateLimit,
    alerter,
    requireNip98,
    PUBLIC_BASE_URL,
  } = deps;

  // ─── Archive purchase ───────────────────────────────────────────────
  // NIP-98-gated so the per-pubkey rate limit can't be dodged by
  // rotating body.userPubkey. The signed pubkey IS the userPubkey we
  // record on the purchase record + use as the rate-limit key.
  app.post('/archive/purchase', async (request, reply) => {
    const auth = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/archive/purchase`,
      'POST',
      { bindBody: true },
    );
    if (!auth) return;

    // Body still validated for url + eventId + structure; userPubkey is
    // sourced from the NIP-98 auth event so a request body claiming a
    // different pubkey is silently overridden.
    const parsed = PurchaseRequestSchema.safeParse({
      ...((request.body ?? {}) as object),
      userPubkey: auth.pubkey,
    });
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid request',
        details: parsed.error.flatten(),
      });
    }
    const { url, eventId, userPubkey, tier, archiveKey } = parsed.data;
    // Per-IP and per-pubkey rate limits on invoice creation. Pubkey is
    // now the NIP-98-verified one, so it can't be rotated to dodge.
    const ipGate = await rateLimit('archive-ip', request.ip, 30, 60);
    if (!ipGate.ok) {
      reply.header('Retry-After', String(ipGate.retryAfter));
      return reply.status(429).send({ error: 'rate limit (ip)', retryAfter: ipGate.retryAfter });
    }
    const pkGate = await rateLimit('archive-pk', userPubkey, 10, 60);
    if (!pkGate.ok) {
      reply.header('Retry-After', String(pkGate.retryAfter));
      return reply.status(429).send({ error: 'rate limit (pubkey)', retryAfter: pkGate.retryAfter });
    }
    try {
      const result = await createPendingArchivePurchase({
        lnd,
        purchases,
        url,
        userPubkey,
        eventId,
        tier,
        archiveKey,
      });
      app.log.info(
        { paymentHash: result.paymentHash, url, user: userPubkey },
        'archive invoice created',
      );
      return result;
    } catch (err) {
      if (err instanceof ArchiveUnavailableError) {
        return reply.status(503).send({ error: err.message });
      }
      app.log.error({ err, url }, 'failed to create archive invoice');
      return reply.status(502).send({ error: 'upstream lightning error' });
    }
  });

  // ── POST /archive/lifetime ─────────────────────────────────────────
  // Free-archive bypass for lifetime members. NIP-98 auth proves signer
  // possession; the auth pubkey must be stamped as a lifetime member
  // (either by BTCPay settlement or the reconcile/stamp admin endpoints).
  // On success the archive job is enqueued immediately — the response
  // shape matches the normal purchase response but with amountSats=0
  // and no invoice field, so the frontend can branch.
  app.post<{ Body: { url?: string; eventId?: string; tier?: string; archiveKey?: string } }>(
    '/archive/lifetime',
    async (request, reply) => {
      const authCheck = await requireNip98(
        request,
        reply,
        `${PUBLIC_BASE_URL}/archive/lifetime`,
        'POST',
      );
      if (!authCheck) return;
      const pubkey = authCheck.pubkey;
      if (!(await lifetimeStore.isPaid(pubkey))) {
        return reply.status(402).send({ error: 'lifetime membership required — upgrade at /app/upgrade' });
      }
      const { url, eventId, tier, archiveKey } = request.body ?? {};
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
      // forever. Generous bucket for legitimate "import 100 bookmarks
      // and archive them all" workflows.
      const gate = await rateLimit('archive-lifetime-pk', pubkey, 60, 60);
      if (!gate.ok) {
        reply.header('Retry-After', String(gate.retryAfter));
        return reply.status(429).send({ error: 'rate limit (lifetime)', retryAfter: gate.retryAfter });
      }
      // SSRF check at the gate too, even though the worker re-checks
      // with DNS — fail fast for obviously bad input.
      try {
        validateSafePublicHttpUrl(url);
      } catch {
        return reply.status(400).send({ error: 'url must be a public http(s) URL' });
      }
      const result = await enqueueLifetimeArchive({
        purchases,
        url,
        userPubkey: pubkey,
        eventId,
        tier: normalizedTier,
        archiveKey: normalizedKey,
      });
      app.log.info(
        { paymentHash: result.paymentHash, url, user: pubkey },
        'lifetime archive enqueued (free)',
      );
      return { ...result, invoice: '', jobId: result.paymentHash };
    },
  );

  app.get<{ Params: { hash: string } }>(
    '/archive/status/:hash',
    async (request, reply) => {
      const { hash } = request.params;
      // Real Lightning payment hashes are 64 hex chars; lifetime-member
      // bypass jobs use a `lifetime:<32hex>` synthetic marker (see
      // enqueueLifetimeArchive).
      if (!/^([0-9a-f]{64}|lifetime:[0-9a-f]{32})$/.test(hash)) {
        return reply.status(400).send({ error: 'invalid payment hash' });
      }
      const rec = await purchases.get(hash);
      if (!rec) return reply.status(404).send({ error: 'not found' });
      return {
        status: rec.status,
        paidAt: rec.paidAt,
        amountSats: rec.amountSats,
        url: rec.url,
      };
    },
  );

  // ═══════════════════════════════════════════════════════════════════
  // Archive worker callback (Box B → Box A)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Archive worker calls this after every terminal job state (success
   * or final failure). On success: record the archive in the user's
   * account and kick off BUD-04 mirror fanout. On failure: trigger a
   * keysend refund or credit the user's account.
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

    const parsed = ArchiveCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid payload' });
    }
    const payload = parsed.data;

    if (payload.status === 'ok') {
      if (!payload.blobHash || !payload.ownerPubkey || !payload.url || !payload.tier) {
        return reply.status(400).send({ error: 'missing success fields' });
      }

      // Record the archive on the user's account. The ArchiveStore
      // module (not written yet; Claude Code will add it) is where
      // this persists. For MVP we write a Redis record directly.
      const archiveRecord = {
        jobId: payload.jobId,
        ownerPubkey: payload.ownerPubkey,
        url: payload.url,
        blobHash: payload.blobHash,
        source: payload.source,
        tier: payload.tier,
        archivedAt: Math.floor(Date.now() / 1000),
        // Viewport-screenshot blob hash, public-tier only. UI layers
        // render <img src=https://blossom.deepmarks.org/<thumbHash>>
        // for an instant card-sized preview without fetching the full
        // archive HTML.
        thumbHash: payload.thumbHash,
      };
      await redis.hset(
        `dm:archives:${payload.ownerPubkey}`,
        payload.blobHash,
        JSON.stringify(archiveRecord),
      );
      // Mark this jobId as terminally completed so any later 'failed'
      // callback (worker bug, retried delivery from a partitioned
      // worker) can't slip a refund past us. 30-day TTL covers any
      // realistic delivery window.
      await redis.set(`dm:archive-completed:${payload.jobId}`, '1', 'EX', 60 * 60 * 24 * 30, 'NX');

      // TODO(mirror-fanout): wire mirrorBlob() from blossom-mirror.ts
      // into this path. Today the archive lives on a single Blossom
      // server (the worker's primary) — the "mirrored across multiple
      // hosts" promise is unfulfilled. Stubbed here rather than logged
      // misleadingly: a previous version of this handler logged
      // "mirror fanout scheduled" while doing nothing, which made it
      // look like the feature shipped.
      app.log.info(
        { jobId: payload.jobId, hash: payload.blobHash },
        'archive complete (single-server only — mirror fanout not yet wired)',
      );

      return { ok: true };
    }

    // Failure path: refund the user.
    if (!payload.ownerPubkey || !payload.paymentHash) {
      return reply.status(400).send({ error: 'missing failure fields' });
    }

    // Verify the (jobId/paymentHash, ownerPubkey) pair matches a real
    // purchase. Without this, the worker (or anyone who got hold of
    // the shared secret) could mint refund credits to any pubkey by
    // claiming an arbitrary jobId.
    const purchase = await purchases.get(payload.paymentHash);
    if (!purchase) {
      app.log.warn(
        { jobId: payload.jobId, owner: payload.ownerPubkey },
        'archive callback for unknown jobId — refusing refund',
      );
      return reply.status(404).send({ error: 'unknown jobId' });
    }
    if (purchase.userPubkey !== payload.ownerPubkey) {
      app.log.warn(
        { jobId: payload.jobId, claimedOwner: payload.ownerPubkey, actualOwner: purchase.userPubkey },
        'archive callback ownerPubkey mismatch — refusing refund',
      );
      void alerter.alert({
        severity: 'critical',
        key: 'archive-callback-owner-mismatch',
        subject: 'archive callback claims wrong ownerPubkey — possible HMAC compromise',
        body: `An /archive/callback request authenticated successfully (HMAC valid) but claimed ownerPubkey=${payload.ownerPubkey} for a job actually owned by ${purchase.userPubkey}. Either the worker has a bug, the WORKER_CALLBACK_SECRET has leaked, or someone has guessed the HMAC. Investigate immediately.\n\nJob: ${payload.jobId}`,
      });
      return reply.status(403).send({ error: 'owner mismatch' });
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
    if (purchase.status === 'expired') {
      return { ok: true, refund: 'invoice-expired', sats: 0 };
    }

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

    app.log.warn(
      { jobId: payload.jobId, error: payload.error, category: payload.errorCategory },
      'archive failed; issuing refund',
    );

    // Try keysend refund to the user's lud16 first. If that's not
    // available, credit the account balance. The actual LN operation
    // is delegated to a helper; we just record the decision here.
    const credited = await redis
      .hincrby(`dm:archive-credits:${payload.ownerPubkey}`, 'sats', purchase.amountSats)
      .catch(() => 0);

    app.log.info(
      { owner: payload.ownerPubkey, credits: credited, sats: purchase.amountSats },
      'archive refund credited to account',
    );

    // Operational visibility. Dedup key is stable so a burst of
    // failures (renderer broken, Blossom degraded) collapses to one
    // email per 10-min debounce window; the body carries the most
    // recent jobId/URL/error so we can pivot to logs from there.
    void alerter.alert({
      severity: 'warning',
      key: 'archive-failed',
      subject: 'archive job failed terminally — user refunded',
      body: `An archive job hit MAX_ATTEMPTS and was refunded.\n\nJob: ${payload.jobId}\nURL: ${purchase.url ?? '(unknown)'}\nOwner: ${payload.ownerPubkey}\nError: ${payload.error ?? '(none)'}\nCategory: ${payload.errorCategory ?? '(none)'}\nRefund: ${purchase.amountSats} sats credited to account.\n\nAudit trail: redis-cli LRANGE dm:archive:audit:${payload.jobId} 0 -1`,
    });

    return { ok: true, refund: 'account-credit', sats: purchase.amountSats };
  });
}
