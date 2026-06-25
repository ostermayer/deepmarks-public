// /favicon — site-favicon redirect. 302 to a public-read Linode URL.
// On cache miss the server walks a four-step fallback chain (direct
// /favicon.ico → homepage <link> parse → Google → DDG) and uploads the
// first hit. All four failing → the caller is 302'd to a default SVG in
// the same bucket.

import { normalizeHost } from '../favicon.js';
import type { Deps } from '../route-deps.js';

export function register(deps: Deps): void {
  const { app, faviconStore } = deps;

  app.get('/favicon', async (request, reply) => {
    const host = normalizeHost((request.query as { host?: unknown } | undefined)?.host);
    if (!host) {
      return reply.status(400).send({ error: 'missing or invalid host' });
    }
    if (!faviconStore) {
      return reply.status(503).send({ error: 'favicon cache not configured' });
    }
    const url = await faviconStore.resolveUrl(host);
    // Short server-side cache on the redirect so Redis remains the source
    // of truth — the redirected object itself has a week-long max-age.
    reply.header('cache-control', 'public, max-age=300');
    return reply.redirect(url, 302);
  });
}
