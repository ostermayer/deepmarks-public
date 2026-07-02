import { z } from 'zod';
import { suggestedCollections } from '../llm-enrichment.js';
import { DEEPINFRA_MODEL_POLICY } from '../llm.js';
import type { Deps } from '../route-deps.js';

const ImportCleanupBodySchema = z.object({
  items: z.array(z.object({
    id: z.string().max(120).optional(),
    url: z.string().max(2_000),
    title: z.string().max(500).optional(),
    description: z.string().max(2_000).optional(),
    tags: z.array(z.string().max(80)).max(32).optional(),
  })).min(1).max(25),
});

const CollectionSuggestQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export function register(deps: Deps): void {
  const { app, llm, requireNip98, PUBLIC_BASE_URL, gateRateLimit, redis, semanticStore, archiveRescueSearch } = deps;

  app.get('/llm/status', async () => ({
    enabled: llm.enabled,
    policy: DEEPINFRA_MODEL_POLICY,
    models: llm.modelSummary(),
    archiveRescueSearch: archiveRescueSearch.summary() ?? { enabled: false },
    queueDepth: await redis.llen('dm:llm:enrich:queue').catch(() => null),
    semanticStore: semanticStore?.stats
      ? await semanticStore.stats().catch(() => ({
        provider: 'qdrant',
        enabled: true,
        healthy: false,
        collection: null,
        pointsCount: null,
        indexedVectorsCount: null,
      }))
      : { enabled: false },
  }));

  app.post('/llm/import/cleanup', async (request, reply) => {
    if (!llm.enabled) return reply.status(503).send({ error: 'LLM enrichment unavailable' });
    const auth = await requireNip98(request, reply, `${PUBLIC_BASE_URL}/llm/import/cleanup`, 'POST', { bindBody: true });
    if (!auth) return;
    if (!(await gateRateLimit(reply, 'llm-import-cleanup', auth.pubkey, 20, 60))) return reply;
    const parsed = ImportCleanupBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const suggestions = await llm.cleanupImportedBookmarks(parsed.data.items);
    return { suggestions };
  });

  app.get('/llm/collections/suggest', async (request, reply) => {
    const auth = await requireNip98(request, reply, `${PUBLIC_BASE_URL}/llm/collections/suggest`, 'GET');
    if (!auth) return;
    const parsed = CollectionSuggestQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid query' });
    const suggestions = await suggestedCollections(redis, auth.pubkey, parsed.data.limit ?? 12);
    return { suggestions };
  });
}
