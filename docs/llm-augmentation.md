# LLM Augmentation

Deepmarks can use DeepInfra to add optional, server-side LLM metadata to
public bookmarks and operational records. The user-authored bookmark event
stays canonical; LLM fields are additive search/index fields and cached
summaries.

## What It Does

- Metadata fetches can ask the LLM for missing bookmark title,
  description, and suggested tags.
- Public bookmark indexing queues a background enrichment job. The worker
  writes `llm_summary`, `llm_tags`, `llm_category`, `llm_language`, and
  `llm_confidence` back into the Meilisearch document without changing the
  user's original tags.
- The worker stores bookmark embeddings in Redis as a durable fallback
  and upserts them into Qdrant for fast ANN-backed
  `GET /search/semantic/public` queries when `QDRANT_URL` is set.
- Archive callbacks can queue an archive summary keyed by owner pubkey and
  Blossom hash.
- Public webpage archive failures can ask the LLM for rescue hints:
  known public mirrors, domain migrations, print/AMP/RSS variants, or
  existing archive URLs. The model does not browse directly; it can
  generate search queries, and Deepmarks can run those through the
  configured archive-rescue search provider. Every result still passes
  the same SSRF guard and HTTP probe before queueing a rescue archive job.
- Monitoring alerts can be summarized into a recent alert-digest list for
  operator review.
- Imported bookmark batches can call `POST /llm/import/cleanup` for
  signed-in cleanup suggestions.
- Signed-in users can call `GET /llm/collections/suggest` to get tag and
  category suggestions derived from their enriched public bookmarks.

Private bookmarks are not sent to DeepInfra by the server. Personal search
over private bookmarks stays browser-local.

## Model Policy

`api/src/llm.ts` enforces `open-source-only` model policy at
startup. If `DEEPINFRA_TOKEN` is configured but any model override is not
in the allowlist, the LLM client is disabled and startup logs:

```text
DeepInfra LLM enrichment disabled by model policy
```

Current defaults:

- chat/enrichment/import/alert/summary:
  `deepseek-ai/DeepSeek-V4-Flash`
- archive rescue: `deepseek-ai/DeepSeek-V4-Pro`
- embedding: `Qwen/Qwen3-Embedding-8B`
- rerank: `Qwen/Qwen3-Reranker-4B`

Approved override families are listed in `api/src/llm.ts`.
Changing providers or allowing a closed model requires changing that
allowlist intentionally.

## Runtime Controls

Set these on Box A for `api`:

```env
DEEPINFRA_TOKEN=
DEEPINFRA_CHAT_MODEL=deepseek-ai/DeepSeek-V4-Flash
DEEPINFRA_RESCUE_MODEL=deepseek-ai/DeepSeek-V4-Pro
DEEPINFRA_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-8B
DEEPINFRA_RERANK_MODEL=Qwen/Qwen3-Reranker-4B
DEEPINFRA_TIMEOUT_MS=8000
ARCHIVE_RESCUE_SEARCH_PROVIDER=searxng
ARCHIVE_RESCUE_SEARCH_URL=http://searxng:8080/search
ARCHIVE_RESCUE_SEARCH_TIMEOUT_MS=6000
ARCHIVE_RESCUE_SEARCH_MAX_RESULTS=10
BRAVE_SEARCH_API_KEY=
LLM_ENABLED=1
LLM_BACKFILL_EXISTING_BOOKMARKS=0
LLM_BACKFILL_PAGE_SIZE=100
LLM_BACKFILL_DELAY_MS=250
QDRANT_URL=http://qdrant:6333
QDRANT_COLLECTION=deepmarks_bookmarks_semantic
QDRANT_TIMEOUT_MS=5000
```

Leave `DEEPINFRA_TOKEN` empty to disable all LLM work. `LLM_ENABLED=0`
is a kill switch even when a token is present.

`DEEPINFRA_RESCUE_MODEL` is separate because archive rescue is low volume
and benefits more from reasoning/structured-output quality than raw
throughput. The default is DeepSeek V4 Pro; bulk bookmark enrichment
stays on DeepSeek V4 Flash.

`ARCHIVE_RESCUE_SEARCH_PROVIDER=searxng` uses the private SearXNG service
in the Box A compose stack. `provider=brave` is also supported when
`BRAVE_SEARCH_API_KEY` is set. Search is only used for public webpage
archive failures; private failures remain client-only because the server
does not retain private archive keys.

## Existing Bookmark Backfill

New public bookmarks are queued as the indexer sees them. Existing
Meilisearch documents are only queued when
`LLM_BACKFILL_EXISTING_BOOKMARKS=1`.

Backfill behavior:

- takes a Redis lock at `dm:llm:backfill:bookmarks:lock`
- resumes from `dm:llm:backfill:bookmarks:cursor`
- reuses any existing Redis embedding and upserts it into Qdrant
- queues normal bookmark enrichment jobs for documents missing embeddings;
  already-enriched documents still get embedded
- marks one-shot scan completion at `dm:llm:backfill:bookmarks:done`
- exposes progress in the admin dashboard under
  `workers.llmEnrichment.stats.backfill`
- exposes LLM queue depth and Qdrant point counts in `GET /llm/status`

Recommended production flow:

1. Deploy with `DEEPINFRA_TOKEN` set and
   `LLM_BACKFILL_EXISTING_BOOKMARKS=0`.
2. Confirm `GET /llm/status` returns `enabled: true` and the expected
   model names.
3. Temporarily set `LLM_BACKFILL_EXISTING_BOOKMARKS=1` and redeploy Box A
   when you intentionally want to enrich the existing public corpus.
4. Watch `workers.llmEnrichment.stats.backfill.scanned`,
   `queued`, and `completedAt` in the admin dashboard. Then confirm
   `GET /llm/status` has a drained `queueDepth` and rising
   `semanticStore.pointsCount`.
5. Set `LLM_BACKFILL_EXISTING_BOOKMARKS=0` again after completion.

To rerun the one-shot backfill, delete
`dm:llm:backfill:bookmarks:done` and optionally
`dm:llm:backfill:bookmarks:cursor` from Redis before enabling it again.

## Endpoints

- `GET /llm/status` returns `{ enabled, policy, models, queueDepth,
  semanticStore }`.
- `POST /llm/import/cleanup` requires NIP-98 auth and returns cleanup
  suggestions for up to 25 imported bookmarks.
- `GET /llm/collections/suggest` requires NIP-98 auth and returns
  user-specific tag/category suggestions.
- `POST /admin/archive-rescue/run` requires admin NIP-98 auth and runs
  archive rescue over stored public failures. It defaults to dry-run.
- `GET /search/semantic/public?q=...` embeds the query, then searches
  Qdrant when configured. Redis-stored vectors remain a fallback path
  while Qdrant is unavailable or empty. Once Qdrant responds, empty
  Qdrant result sets are treated as real empty results. Query embeddings
  are cached in Redis by normalized query + embedding model, so repeated
  public/tag searches do not pay the DeepInfra embedding round trip.

The normal `/search/public` endpoint still uses Meilisearch lexical search,
but its searchable attributes include the additive LLM fields.
