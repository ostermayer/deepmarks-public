// /web-push/* routes.
//
//   GET  /web-push/public-key                       no auth — VAPID public key bytes for SubscribeOptions
//   POST /web-push/subscribe   (NIP-98 auth req'd)  registers a PushSubscription for the caller's pubkey
//   POST /web-push/unsubscribe (NIP-98 auth req'd)  removes one endpoint
//
// The frontend's settings page reads the public key, calls
// pushManager.subscribe(...), and POSTs the resulting subscription
// to /web-push/subscribe.

import { z } from 'zod';
import type { Deps } from '../route-deps.js';
import {
  ensureVapid,
  vapidPublicKey,
  saveSubscription,
  removeSubscription,
  type PushSubscriptionJSON,
} from '../web-push.js';

const SubscribeBodySchema = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
  }),
});

const UnsubscribeBodySchema = z.object({
  endpoint: z.string().url(),
});

export function register(deps: Deps): void {
  const { app, redis, requireNip98, PUBLIC_BASE_URL } = deps;

  app.get('/web-push/public-key', async (_request, reply) => {
    if (!ensureVapid()) {
      return reply.status(503).send({ error: 'web push not configured' });
    }
    reply.header('cache-control', 'public, max-age=3600');
    return { publicKey: vapidPublicKey() };
  });

  app.post('/web-push/subscribe', async (request, reply) => {
    const auth = await requireNip98(request, reply, `${PUBLIC_BASE_URL}/web-push/subscribe`, 'POST', { bindBody: true });
    if (!auth) return;
    const parsed = SubscribeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid subscription', details: parsed.error.flatten() });
    }
    await saveSubscription(redis, auth.pubkey, parsed.data.subscription as PushSubscriptionJSON);
    return { ok: true };
  });

  app.post('/web-push/unsubscribe', async (request, reply) => {
    const auth = await requireNip98(request, reply, `${PUBLIC_BASE_URL}/web-push/unsubscribe`, 'POST', { bindBody: true });
    if (!auth) return;
    const parsed = UnsubscribeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    await removeSubscription(redis, auth.pubkey, parsed.data.endpoint);
    return { ok: true };
  });
}
