// /archive/* — lifetime archive enqueue, legacy purchase guard, status
// polling, and the worker callback that records terminal job
// state (success or final failure).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import {
  enqueueLifetimeArchive,
} from '../archive-purchase.js';
import { validateSafePublicHttpUrl } from '../safe-url.js';
import { publicWebUrl } from '../frontend-url.js';
import { normalizeMirrorUrls } from '../mirror-urls.js';
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
  /** BUD-04 mirror fanout results from archive-worker. The primary
   *  Blossom upload already succeeded before callback. */
  mirrors: z.array(z.object({
    url: z.string().min(1),
    ok: z.boolean(),
    error: z.string().optional(),
  })).optional(),
  // Failure fields
  error: z.string().optional(),
  errorCategory: z.enum(['retryable', 'permanent']).optional(),
  paymentHash: z.string().optional(),
});

export function register(deps: Deps): void {
  const {
    app,
    purchases,
    redis,
    lifetimeStore,
    rateLimit,
    alerter,
    requireNip98,
    PUBLIC_BASE_URL,
  } = deps;

  // ─── Legacy metered archive guard ──────────────────────────────────
  // Disabled in production: archiving is now a lifetime-only capability.
  // Keep the route as a compatibility stop so old clients fail clearly
  // without creating a Lightning invoice.
  app.post('/archive/purchase', async (request, reply) => {
    const gate = await rateLimit('archive-disabled-ip', request.ip, 60, 60);
    if (!gate.ok) {
      reply.header('Retry-After', String(gate.retryAfter));
      return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
    }
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
  app.post<{ Body: { url?: string; eventId?: string; tier?: string; archiveKey?: string; mirrorUrls?: unknown } }>(
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
      const { url, eventId, tier, archiveKey, mirrorUrls } = request.body ?? {};
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
      const gate = await rateLimit('archive-lifetime-pk', pubkey, 5000, 24 * 60 * 60);
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
      const normalizedMirrorUrls = normalizeMirrorUrls(mirrorUrls);
      if (!normalizedMirrorUrls.ok) {
        return reply.status(400).send({ error: normalizedMirrorUrls.error });
      }
      const result = await enqueueLifetimeArchive({
        purchases,
        url,
        userPubkey: pubkey,
        eventId,
        tier: normalizedTier,
        archiveKey: normalizedKey,
        mirrorUrls: normalizedMirrorUrls.urls,
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
      const doneRaw = await redis.get(`dm:archive:done:${hash}`);
      if (doneRaw) {
        try {
          const done = JSON.parse(doneRaw) as {
            status?: 'ok' | 'failed';
            blobHash?: string;
            error?: string;
          };
          if (done.status === 'ok') {
            return {
              jobId: hash,
              state: 'done',
              status: 'archived',
              blossomHash: done.blobHash,
            };
          }
          if (done.status === 'failed') {
            return {
              jobId: hash,
              state: 'failed',
              status: 'failed',
              error: done.error ?? 'archive job failed',
            };
          }
        } catch {
          // Corrupt terminal record: fall through to purchase state
          // rather than 500ing the user's polling loop.
        }
      }
      const rec = await purchases.get(hash);
      if (!rec) return reply.status(404).send({ error: 'not found' });
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
        mirrors: payload.mirrors,
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

      const mirrors = payload.mirrors ?? [];
      const failedMirrors = mirrors.filter((m) => !m.ok);
      if (mirrors.length === 0) {
        app.log.warn(
          { jobId: payload.jobId, hash: payload.blobHash },
          'archive complete but no Blossom mirror fanout results were reported',
        );
      } else if (failedMirrors.length > 0) {
        app.log.warn(
          { jobId: payload.jobId, hash: payload.blobHash, failedMirrors },
          'archive complete with partial Blossom mirror fanout',
        );
        void alerter.alert({
          severity: 'warning',
          key: 'archive-mirror-fanout-partial',
          subject: 'archive completed with partial Blossom mirror fanout',
          body: `Archive job ${payload.jobId} uploaded to the primary Blossom server, but ${failedMirrors.length}/${mirrors.length} mirror request(s) failed.\n\nURL: ${payload.url}\nHash: ${payload.blobHash}\nFailures:\n${failedMirrors.map((m) => `- ${m.url}: ${m.error ?? 'unknown error'}`).join('\n')}`,
        });
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

    if (purchase.amountSats > 0) {
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

    app.log.warn(
      { jobId: payload.jobId, error: payload.error, category: payload.errorCategory },
      purchase.amountSats > 0 ? 'archive failed; issuing refund credit' : 'lifetime archive failed',
    );

    let credited = 0;
    if (purchase.amountSats > 0) {
      credited = await redis
        .hincrby(`dm:archive-credits:${payload.ownerPubkey}`, 'sats', purchase.amountSats)
        .catch(() => 0);
      app.log.info(
        { owner: payload.ownerPubkey, credits: credited, sats: purchase.amountSats },
        'archive refund credited to account',
      );
    }

    // Operational visibility. Dedup key is stable so a burst of
    // failures (renderer broken, Blossom degraded) collapses to one
    // email per 10-min debounce window; the body carries the most
    // recent jobId/URL/error so we can pivot to logs from there.
    void alerter.alert({
      severity: 'warning',
      key: 'archive-failed',
      subject: purchase.amountSats > 0
        ? 'legacy metered archive failed terminally — user credited'
        : 'lifetime archive failed terminally',
      body: `An archive job hit MAX_ATTEMPTS.\n\nJob: ${payload.jobId}\nURL: ${purchase.url ?? '(unknown)'}\nOwner: ${payload.ownerPubkey}\nError: ${payload.error ?? '(none)'}\nCategory: ${payload.errorCategory ?? '(none)'}\nCredit: ${purchase.amountSats > 0 ? `${purchase.amountSats} sats credited to account` : 'none (lifetime archive job)'}.\n\nAudit trail: redis-cli LRANGE dm:archive:audit:${payload.jobId} 0 -1`,
    });

    return {
      ok: true,
      refund: purchase.amountSats > 0 ? 'account-credit' : 'not-needed',
      sats: purchase.amountSats,
      credits: credited,
    };
  });
}
