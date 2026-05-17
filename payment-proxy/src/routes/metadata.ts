// /metadata — URL metadata preview used by the bookmark save form to
// autofill title/description + seed tag suggestions from the page's
// <meta> tags. Best-effort: a 5xx / timeout / non-HTML response returns
// `{url, suggestedTags: []}` so the UI can still let the user type their
// own metadata.
//
// Rate-limited per client IP (Redis-backed, 20 req/min by default).
// Without this the endpoint is an open proxy / crawler-for-hire.
// `trustProxy: true` at the Fastify level makes `request.ip` honour
// the caddy `X-Forwarded-For` on Box A.

import { parseAllowedUrl } from '../metadata.js';
import type { Deps } from '../route-deps.js';

export function register(deps: Deps): void {
  const { app, metadataStore } = deps;

  app.get('/metadata', async (request, reply) => {
    const raw = (request.query as { url?: unknown } | undefined)?.url;
    const parsed = parseAllowedUrl(raw);
    if (!parsed) {
      return reply.status(400).send({ error: 'missing or invalid url' });
    }

    const gate = await metadataStore.rateLimitCheck(request.ip);
    if (!gate.ok) {
      reply.header('retry-after', String(gate.retryAfter));
      return reply.status(429).send({ error: 'too many requests, try again shortly' });
    }

    const meta = await metadataStore.resolve(parsed.toString());
    if (!meta) {
      return reply.status(400).send({ error: 'missing or invalid url' });
    }
    reply.header('cache-control', 'public, max-age=300');
    return reply.send(meta);
  });
}
