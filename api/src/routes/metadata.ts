// /metadata — URL metadata preview used by the bookmark save form to
// autofill title/description + seed tag suggestions from the page's
// <meta> tags, and classify direct media URLs by content type when
// they do not have a useful file extension. Best-effort: a 5xx / timeout /
// unsupported non-HTML response returns
// `{url, suggestedTags: []}` so the UI can still let the user type their
// own metadata.
//
// Rate-limited per client IP (Redis-backed, 20 req/min by default).
// Without this the endpoint is an open proxy / crawler-for-hire.
// `trustProxy: true` at the Fastify level makes `request.ip` honour
// the caddy `X-Forwarded-For` on Box A.

import { parseAllowedUrl } from '../metadata.js';
import { enrichMetadataInline, mergeMetadataEnrichment } from '../llm-enrichment.js';
import type { Deps } from '../route-deps.js';

export function register(deps: Deps): void {
  const { app, metadataStore, llm } = deps;

  app.get('/metadata', async (request, reply) => {
    const query = request.query as { url?: unknown; enrich?: unknown; fast?: unknown } | undefined;
    const parsed = parseAllowedUrl(query?.url);
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
    // Fast path for the mobile share sheets: `enrich=0` (or `fast=1`)
    // skips the inline LLM round-trip, which otherwise blocks the
    // response on thin-metadata pages (no description / few tags) — the
    // exact pages that slow the share sheet's autofill. The page-derived
    // metadata is already Redis-cached, so this returns near-instantly,
    // and the saved bookmark still gets LLM-enriched by the backend
    // backfill pipeline once published.
    const skipEnrich = query?.enrich === '0' || query?.fast === '1';
    const enrichment = skipEnrich ? null : await enrichMetadataInline(llm, meta);
    const enriched = mergeMetadataEnrichment(meta, enrichment);
    reply.header('cache-control', 'public, max-age=300');
    return reply.send(enriched);
  });
}
