// Cheap inline checks consumed by strfry's write-policy plugin and by
// blossom-server on every upload/mirror/read. All three are fast-path
// Redis lookups that the moderation pipeline gates on.

import type { Deps } from '../route-deps.js';

export function register(deps: Deps): void {
  const { app, accounts, blocklist } = deps;

  // ── GET /relay/check-pubkey/:pubkey ────────────────────────────────
  // Called by strfry's write-policy plugin on every incoming event.
  // Returns 200 if the pubkey is a registered Deepmarks account AND
  // not currently suspended; 403 otherwise. Fast path — single Redis
  // GET + single SISMEMBER.
  app.get<{ Params: { pubkey: string } }>(
    '/relay/check-pubkey/:pubkey',
    async (request, reply) => {
      const { pubkey } = request.params;
      if (!/^[0-9a-f]{64}$/.test(pubkey)) {
        return reply.status(400).send({ error: 'invalid pubkey format' });
      }

      // Check suspension first — it's a separate store and takes
      // precedence over account existence.
      if (await blocklist.isPubkeySuspended(pubkey)) {
        return reply.status(403).send({ error: 'pubkey suspended' });
      }

      const account = await accounts.getByPubkey(pubkey);
      if (!account) {
        return reply.status(403).send({ error: 'pubkey not a registered account' });
      }
      return { ok: true };
    },
  );

  // ── GET /relay/check-event ──────────────────────────────────────────
  // Called by the relay's read-time filter to drop delisted events
  // from outgoing subscriptions.
  app.get<{ Querystring: { id?: string; url?: string } }>(
    '/relay/check-event',
    async (request, reply) => {
      const { id, url } = request.query;
      if (id && await blocklist.isEventDelisted(id)) {
        return { blocked: true, reason: 'event delisted' };
      }
      if (url && await blocklist.isUrlBlocked(url)) {
        return { blocked: true, reason: 'url blocklisted' };
      }
      return { blocked: false };
    },
  );

  // ── GET /blossom/check-hash/:hash ──────────────────────────────────
  // Called by blossom-server on every upload/mirror/read. A 410 from
  // this endpoint tells blossom-server to reject the operation.
  app.get<{ Params: { hash: string } }>(
    '/blossom/check-hash/:hash',
    async (request, reply) => {
      const { hash } = request.params;
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        return reply.status(400).send({ error: 'invalid hash' });
      }
      if (await blocklist.isHashBlocked(hash)) {
        return reply.status(410).send({ blocked: true, reason: 'hash blocklisted' });
      }
      return { blocked: false };
    },
  );
}
