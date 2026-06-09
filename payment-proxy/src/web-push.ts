// Web Push subscription storage + push delivery.
//
// Flow:
//   1. Frontend calls navigator.serviceWorker.register(...)
//   2. Frontend calls registration.pushManager.subscribe({ userVisibleOnly: true,
//        applicationServerKey: VAPID_PUBLIC_KEY })
//   3. Frontend POSTs { pubkey, subscription } to /web-push/subscribe
//   4. We store the subscription in Redis (per pubkey, multiple
//      devices possible).
//   5. The zap-push worker watches kind:9735 zap receipts on our
//      indexer relay. For each receipt whose `p` (zap recipient)
//      tag matches a subscribed pubkey, we look up the bookmark
//      being zapped and send a Web Push to every device.
//
// Storage shape:
//   dm:push:subs:<pubkey>   Redis SET of stringified PushSubscription
//                            JSON objects. SETs because one user can
//                            subscribe from multiple devices.
//
// VAPID identity is the brand pubkey by analogy with the zap-receipt
// signer; the key pair is independent of any Nostr signer and lives
// in env vars on Box A.

import webPush from 'web-push';
import type { Redis } from 'ioredis';

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const SUBS_PREFIX = 'dm:push:subs:';
const MAX_SUBS_PER_PUBKEY = 10; // one user / many devices, but cap to keep memory bounded

let vapidConfigured = false;

/** Configure web-push with the VAPID key pair. Safe to call multiple
 *  times — only sets up once. Returns false if the env isn't
 *  configured (e.g. dev), so the rest of the app can detect and
 *  skip push features. */
export function ensureVapid(): boolean {
  if (vapidConfigured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? 'mailto:alerts@deepmarks.org';
  if (!publicKey || !privateKey) return false;
  webPush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

export async function saveSubscription(
  redis: Redis,
  pubkey: string,
  subscription: PushSubscriptionJSON,
): Promise<void> {
  if (!isHexPubkey(pubkey)) return;
  if (!isPushSubscription(subscription)) return;
  const key = SUBS_PREFIX + pubkey.toLowerCase();
  const value = JSON.stringify(subscription);
  await redis.sadd(key, value);
  // Cap so a misbehaving client can't fill our memory by re-
  // subscribing on every reload. New subs evict the oldest member.
  const count = await redis.scard(key).catch(() => 0);
  if (count > MAX_SUBS_PER_PUBKEY) {
    const members = await redis.smembers(key);
    // We don't know insertion order; just trim arbitrarily down to
    // MAX_SUBS_PER_PUBKEY entries. Real victims will re-subscribe on
    // next page load.
    const trim = members.slice(0, count - MAX_SUBS_PER_PUBKEY);
    if (trim.length > 0) await redis.srem(key, ...trim);
  }
}

export async function removeSubscription(
  redis: Redis,
  pubkey: string,
  endpoint: string,
): Promise<void> {
  if (!isHexPubkey(pubkey) || !endpoint) return;
  const key = SUBS_PREFIX + pubkey.toLowerCase();
  const members = await redis.smembers(key);
  const toRemove = members.filter((raw) => {
    try {
      const parsed = JSON.parse(raw) as PushSubscriptionJSON;
      return parsed.endpoint === endpoint;
    } catch {
      return false;
    }
  });
  if (toRemove.length > 0) await redis.srem(key, ...toRemove);
}

export async function listSubscriptions(
  redis: Redis,
  pubkey: string,
): Promise<PushSubscriptionJSON[]> {
  if (!isHexPubkey(pubkey)) return [];
  const key = SUBS_PREFIX + pubkey.toLowerCase();
  const members = await redis.smembers(key);
  const out: PushSubscriptionJSON[] = [];
  for (const raw of members) {
    try {
      const parsed = JSON.parse(raw) as PushSubscriptionJSON;
      if (isPushSubscription(parsed)) out.push(parsed);
    } catch {
      // skip corrupt entries
    }
  }
  return out;
}

export interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  icon?: string;
  /** Notification tag — same tag replaces a prior notification (e.g.
   *  multiple zaps on the same bookmark collapse to one entry). */
  tag?: string;
}

/** Send a push to every subscription for `pubkey`. Subscriptions that
 *  return 404/410 are stale (user uninstalled, browser cleared) — we
 *  remove them. */
export async function sendPush(
  redis: Redis,
  pubkey: string,
  payload: PushPayload,
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): Promise<{ delivered: number; expired: number; failed: number }> {
  if (!ensureVapid()) {
    logger.warn('sendPush: VAPID not configured — skipping');
    return { delivered: 0, expired: 0, failed: 0 };
  }
  const subs = await listSubscriptions(redis, pubkey);
  if (subs.length === 0) return { delivered: 0, expired: 0, failed: 0 };
  let delivered = 0;
  let expired = 0;
  let failed = 0;
  await Promise.all(subs.map(async (sub) => {
    try {
      await webPush.sendNotification(sub, JSON.stringify(payload));
      delivered += 1;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode ?? 0;
      if (code === 404 || code === 410) {
        // Gone — drop it.
        await removeSubscription(redis, pubkey, sub.endpoint);
        expired += 1;
      } else {
        failed += 1;
        logger.warn({ err, endpoint: sub.endpoint }, 'web-push delivery failed');
      }
    }
  }));
  return { delivered, expired, failed };
}

function isHexPubkey(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);
}

function isPushSubscription(value: unknown): value is PushSubscriptionJSON {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.endpoint !== 'string' || !v.endpoint.startsWith('https://')) return false;
  const keys = v.keys;
  if (!keys || typeof keys !== 'object') return false;
  const k = keys as Record<string, unknown>;
  return typeof k.p256dh === 'string' && typeof k.auth === 'string';
}
