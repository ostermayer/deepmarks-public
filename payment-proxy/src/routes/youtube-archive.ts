// /add-on/video-archive/* — one-time private media archive add-on.
//
// The public route name stays "video-archive" for older clients and
// stored links, but the product is now media archive: a lifetime-only
// one-time add-on that lets the archive worker automatically capture
// primary video or audio for bookmarked pages. Media jobs are always
// private. The client supplies a per-job AES key; the worker uploads
// encrypted bytes and the account archive list exposes the record only
// to the bookmark owner's NIP-98-authenticated session.

import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { createVideoArchiveCheckoutInvoice } from '../btcpay.js';
import { sanitizeRedirectUrl } from './lifetime.js';
import { publicWebUrl } from '../frontend-url.js';
import {
  MEDIA_ARCHIVE_ADDON_PRICE_SATS,
} from '../media-archive-addon.js';
import { normalizeVideoArchiveInput, VIDEO_ARCHIVE_COST_SATS } from '../video-archive.js';
import type { Deps } from '../route-deps.js';

const CHECKOUT_PATHS = [
  '/add-on/video-archive/checkout',
  '/add-on/media-archive/checkout',
] as const;
const STATUS_PATHS = [
  '/add-on/video-archive/status',
  '/add-on/media-archive/status',
] as const;
const ENQUEUE_PATHS = [
  '/add-on/video-archive/enqueue',
  '/add-on/media-archive/enqueue',
] as const;

export function register(deps: Deps): void {
  const {
    app,
    btcPay,
    purchases,
    redis,
    lifetimeStore,
    mediaArchiveAddonStore,
    requireNip98,
    gateRateLimit,
    PUBLIC_BASE_URL,
  } = deps;

  for (const path of STATUS_PATHS) {
    app.get(path, async (request, reply) => {
      const auth = await requireNip98(
        request,
        reply,
        `${PUBLIC_BASE_URL}${path}`,
        'GET',
      );
      if (!auth) return;
      return {
        purchased: await mediaArchiveAddonStore.isPaid(auth.pubkey),
        paidAt: await mediaArchiveAddonStore.paidAt(auth.pubkey),
        amountSats: MEDIA_ARCHIVE_ADDON_PRICE_SATS,
        lifetimeRequired: !(await lifetimeStore.isPaid(auth.pubkey)),
      };
    });
  }

  for (const path of CHECKOUT_PATHS) {
    app.post<{ Body: { redirectUrl?: string } }>(path, async (request, reply) => {
      const auth = await requireNip98(
        request,
        reply,
        `${PUBLIC_BASE_URL}${path}`,
        'POST',
        { bindBody: true },
      );
      if (!auth) return;

      if (!(await gateRateLimit(reply, 'media-archive-addon-checkout', auth.pubkey, 10, 60))) return reply;

      if (!(await lifetimeStore.isPaid(auth.pubkey))) {
        return reply.status(402).send({ error: 'lifetime membership required before buying the media archive add-on' });
      }
      if (await mediaArchiveAddonStore.isPaid(auth.pubkey)) {
        return reply.status(409).send({ error: 'media archive add-on already purchased' });
      }
      if (!btcPay) {
        return reply.status(503).send({ error: 'media archive checkout is not available on this server' });
      }

      const redirectUrl = sanitizeRedirectUrl(
        (request.body ?? {}).redirectUrl,
        PUBLIC_BASE_URL,
      ) ?? publicWebUrl(PUBLIC_BASE_URL, '/app/settings');
      const invoice = await createVideoArchiveCheckoutInvoice(btcPay, {
        pubkey: auth.pubkey,
        amountSats: MEDIA_ARCHIVE_ADDON_PRICE_SATS,
        orderId: `deepmarks-media-archive-addon-${auth.pubkey.slice(0, 12)}-${Date.now()}`,
        description: 'Deepmarks media archive add-on',
        redirectUrl,
        metadata: {
          mediaArchiveAddon: true,
        },
      });
      await mediaArchiveAddonStore.stagePending({
        pubkey: auth.pubkey,
        invoiceId: invoice.id,
        amountSats: MEDIA_ARCHIVE_ADDON_PRICE_SATS,
        createdAt: Math.floor(Date.now() / 1000),
      });
      return {
        invoiceId: invoice.id,
        checkoutLink: invoice.checkoutLink,
        amountSats: MEDIA_ARCHIVE_ADDON_PRICE_SATS,
        expiresAt: invoice.expirationTime,
      };
    });
  }

  for (const path of ENQUEUE_PATHS) {
    app.post<{
      Body: {
        url?: string;
        archiveKey?: string;
        eventId?: string;
        bookmarkSavedAt?: unknown;
      };
    }>(path, async (request, reply) => {
      const auth = await requireNip98(
        request,
        reply,
        `${PUBLIC_BASE_URL}${path}`,
        'POST',
        { bindBody: true },
      );
      if (!auth) return;

      if (!(await gateRateLimit(reply, 'media-archive-enqueue', auth.pubkey, 500, 24 * 60 * 60))) return reply;
      if (!(await lifetimeStore.isPaid(auth.pubkey))) {
        return reply.status(402).send({ error: 'lifetime membership required' });
      }
      if (!(await mediaArchiveAddonStore.isPaid(auth.pubkey))) {
        return reply.status(402).send({ error: 'media archive add-on required' });
      }

      const { url, archiveKey, eventId, bookmarkSavedAt } = request.body ?? {};
      if (typeof url !== 'string' || !url.trim()) {
        return reply.status(400).send({ error: 'url required' });
      }
      if (typeof archiveKey !== 'string' || !/^[A-Za-z0-9+/]{43}=?$/.test(archiveKey)) {
        return reply.status(400).send({ error: 'archiveKey required (base64, 32 bytes)' });
      }
      let normalized: ReturnType<typeof normalizeVideoArchiveInput>;
      try {
        normalized = normalizeVideoArchiveInput(url);
      } catch {
        return reply.status(400).send({ error: 'url must be a public http(s) URL' });
      }
      const normalizedBookmarkSavedAt = normalizeBookmarkSavedAt(bookmarkSavedAt);
      if (bookmarkSavedAt !== undefined && normalizedBookmarkSavedAt === undefined) {
        return reply.status(400).send({ error: 'bookmarkSavedAt must be a valid unix timestamp' });
      }

      const jobId = createMediaArchiveJobId();
      await purchases.create({
        url: normalized.url,
        eventId,
        userPubkey: auth.pubkey,
        paymentHash: jobId,
        invoice: '',
        amountSats: 0,
        status: 'pending',
        createdAt: Math.floor(Date.now() / 1000),
        tier: 'private',
        archiveKey,
        bookmarkSavedAt: normalizedBookmarkSavedAt,
        kind: 'media',
        videoId: normalized.videoId,
        videoContentKey: normalized.contentKey,
      });
      const paid = await purchases.markPaid(jobId);
      if (paid) await purchases.enqueueArchiveJob(paid);
      return {
        paymentHash: jobId,
        jobId,
        amountSats: 0,
        canonicalUrl: normalized.url,
        videoId: normalized.videoId,
        videoContentKey: normalized.contentKey,
      };
    });
  }

  // Legacy poll target for old hosted-checkout clients. It now only
  // reports archived media jobs that were created through older builds;
  // current clients use /archive/status/:jobId for worker state and
  // /add-on/video-archive/status for entitlement state.
  app.get<{ Params: { paymentHash: string } }>(
    '/add-on/video-archive/status/:paymentHash',
    async (request, reply) => legacyMediaJobStatus(request.params.paymentHash, reply),
  );
  app.get<{ Params: { paymentHash: string } }>(
    '/add-on/youtube-archive/status/:paymentHash',
    async (request, reply) => legacyMediaJobStatus(request.params.paymentHash, reply),
  );

  async function legacyMediaJobStatus(paymentHash: string, reply: FastifyReply) {
    const doneRaw = await redis.get(`dm:archive:done:${paymentHash}`);
    let done: Record<string, unknown> | null = null;
    if (doneRaw) {
      try { done = JSON.parse(doneRaw) as Record<string, unknown>; }
      catch { done = null; }
    }
    const purchase = await purchases.get(paymentHash);
    if (!purchase && !done) {
      return reply.status(404).send({ error: 'unknown paymentHash' });
    }
    const doneStatus = typeof done?.status === 'string' ? done.status : 'unknown';
    return {
      paymentHash,
      status: purchase?.status ?? doneStatus,
      amountSats: purchase?.amountSats ?? VIDEO_ARCHIVE_COST_SATS,
      videoId: purchase?.videoId,
      videoContentKey: purchase?.videoContentKey,
      canonicalUrl: purchase?.url,
      done,
    };
  }
}

function createMediaArchiveJobId(): `media:${string}` {
  return `media:${randomBytes(16).toString('hex')}`;
}

function normalizeBookmarkSavedAt(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n > 0 && n < 4_102_444_800 ? n : undefined;
}
