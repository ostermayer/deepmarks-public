// Cheap inline checks consumed by blossom-server on every
// upload/mirror/read and by the relay's read-time delist filter. Both
// are fast-path Redis lookups the moderation pipeline gates on.
// (A /relay/check-pubkey route lived here until 2026-08-23; the strfry
// write-policy plugin reads dm:registered:pubkeys from Redis directly
// and never called it.)

import type { Deps } from '../route-deps.js';

export function register(deps: Deps): void {
  const { app, blocklist } = deps;

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
