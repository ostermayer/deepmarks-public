import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import type { BookmarkDoc, MeilisearchClient, SearchResult } from './search.js';
import type {
  AlertDigest,
  ArchiveSummary,
  ArchiveSummaryInput,
  BookmarkEnrichment,
  DeepInfraClient,
} from './llm.js';
import type { SemanticSearchFilters, SemanticVectorStore } from './semantic-vector-store.js';

const QUEUE_KEY = 'dm:llm:enrich:queue';
const BOOKMARK_PREFIX = 'dm:llm:bookmark:';
const ARCHIVE_PREFIX = 'dm:llm:archive:';
const ALERT_DIGEST_PREFIX = 'dm:llm:alert:';
const EMBEDDING_PREFIX = 'dm:llm:embedding:bookmark:';
const QUERY_EMBEDDING_PREFIX = 'dm:llm:query-embedding:';
const SEMANTIC_DOC_PREFIX = 'dm:llm:semantic-doc:';
const SEMANTIC_SET = 'dm:llm:semantic-bookmarks';
const USER_TAGS_PREFIX = 'dm:llm:user-tags:';
const USER_CATEGORIES_PREFIX = 'dm:llm:user-categories:';
const SEEN_PREFIX = 'dm:llm:seen:';
const BOOKMARK_BACKFILL_LOCK_KEY = 'dm:llm:backfill:bookmarks:lock';
const BOOKMARK_BACKFILL_CURSOR_KEY = 'dm:llm:backfill:bookmarks:cursor';
const BOOKMARK_BACKFILL_DONE_KEY = 'dm:llm:backfill:bookmarks:done';
const DEFAULT_SCAN_LIMIT = 5_000;
const DEFAULT_BACKFILL_PAGE_SIZE = 100;
const DEFAULT_BACKFILL_DELAY_MS = 250;
const MAX_JOB_ATTEMPTS = 3;
const SEEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const QUERY_EMBEDDING_TTL_SECONDS = 60 * 60 * 24 * 7;

export type LlmEnrichmentJob =
  | { type: 'bookmark'; doc: BookmarkDoc; queuedAt: number; attempts?: number; lastError?: string }
  | { type: 'archive'; ownerPubkey: string; blobHash: string; input: ArchiveSummaryInput; queuedAt: number; attempts?: number; lastError?: string }
  | { type: 'alert'; id: string; subject: string; body: string; severity: string; key: string; queuedAt: number; attempts?: number; lastError?: string };

export interface LlmEnrichmentWorkerStats {
  startedAt: number | null;
  processed: number;
  failed: number;
  retried: number;
  dropped: number;
  lastJobAt: number | null;
  lastError?: string;
  enabled: boolean;
  models: Record<string, string> | null;
  backfill: {
    enabled: boolean;
    running: boolean;
    scanned: number;
    queued: number;
    cursor: number;
    completedAt: number | null;
    lastError?: string;
  };
}

export interface LlmEnrichmentWorkerLogger {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
}

export async function queueBookmarkEnrichment(redis: Redis, doc: BookmarkDoc): Promise<boolean> {
  const claimed = await redis.set(`${SEEN_PREFIX}bookmark:${doc.id}`, '1', 'EX', SEEN_TTL_SECONDS, 'NX');
  if (claimed !== 'OK') return false;
  await redis.rpush(QUEUE_KEY, JSON.stringify({ type: 'bookmark', doc, queuedAt: Date.now() } satisfies LlmEnrichmentJob));
  return true;
}

export async function queueArchiveSummary(
  redis: Redis,
  input: { ownerPubkey: string; blobHash: string; archive: ArchiveSummaryInput },
): Promise<boolean> {
  const claimed = await redis.set(`${SEEN_PREFIX}archive:${input.blobHash}`, '1', 'EX', SEEN_TTL_SECONDS, 'NX');
  if (claimed !== 'OK') return false;
  await redis.rpush(QUEUE_KEY, JSON.stringify({
    type: 'archive',
    ownerPubkey: input.ownerPubkey,
    blobHash: input.blobHash,
    input: input.archive,
    queuedAt: Date.now(),
  } satisfies LlmEnrichmentJob));
  return true;
}

export async function queueAlertDigest(
  redis: Redis,
  input: { subject: string; body: string; severity: string; key: string },
): Promise<void> {
  const id = `${Date.now()}:${Math.random().toString(16).slice(2)}`;
  await redis.rpush(QUEUE_KEY, JSON.stringify({ type: 'alert', id, ...input, queuedAt: Date.now() } satisfies LlmEnrichmentJob));
}

export class LlmEnrichmentWorker {
  readonly stats: LlmEnrichmentWorkerStats;
  private stopped = true;
  private loopPromise: Promise<void> | null = null;
  private backfillPromise: Promise<void> | null = null;
  /** Dedicated Redis connection for BRPOP. Blocking reads serialize every
   *  other command on the same connection, including hot API route reads. */
  private blockingRedis: Redis | null = null;

  constructor(
    private readonly deps: {
      redis: Redis;
      meili: MeilisearchClient;
      llm: DeepInfraClient;
      semanticStore?: SemanticVectorStore | null;
      logger: LlmEnrichmentWorkerLogger;
    },
  ) {
    this.stats = {
      startedAt: null,
      processed: 0,
      failed: 0,
      retried: 0,
      dropped: 0,
      lastJobAt: null,
      enabled: deps.llm.enabled,
      models: deps.llm.modelSummary(),
      backfill: {
        enabled: bookmarkBackfillEnabled(),
        running: false,
        scanned: 0,
        queued: 0,
        cursor: 0,
        completedAt: null,
      },
    };
  }

  async start(): Promise<void> {
    if (!this.deps.llm.enabled) {
      this.deps.logger.warn('DeepInfra token not configured — LLM enrichment worker disabled');
      return;
    }
    if (!this.stopped) return;
    this.stopped = false;
    this.blockingRedis = this.deps.redis.duplicate();
    this.stats.startedAt = Date.now();
    this.loopPromise = this.loop();
    this.backfillPromise = this.backfillExistingBookmarks();
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.blockingRedis?.disconnect();
    await this.loopPromise?.catch(() => undefined);
    await this.backfillPromise?.catch(() => undefined);
    this.blockingRedis = null;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        if (!this.blockingRedis) break;
        const row = await this.blockingRedis.brpop(QUEUE_KEY, 5);
        if (!row) continue;
        await this.processRaw(row[1]);
      } catch (err) {
        if (this.stopped) break;
        this.stats.failed += 1;
        this.stats.lastError = (err as Error).message;
        this.deps.logger.error({ err }, 'LLM enrichment worker loop failed');
      }
    }
  }

  private async processRaw(raw: string): Promise<void> {
    let job: LlmEnrichmentJob;
    try {
      job = JSON.parse(raw) as LlmEnrichmentJob;
    } catch {
      this.stats.failed += 1;
      return;
    }
    this.stats.lastJobAt = Date.now();
    try {
      if (job.type === 'bookmark') await this.processBookmark(job.doc);
      else if (job.type === 'archive') await this.processArchive(job);
      else await this.processAlert(job);
      this.stats.processed += 1;
    } catch (err) {
      this.stats.failed += 1;
      this.stats.lastError = (err as Error).message;
      const nextAttempts = (job.attempts ?? 0) + 1;
      if (nextAttempts < MAX_JOB_ATTEMPTS) {
        await this.requeueJob(job, nextAttempts, (err as Error).message);
        this.stats.retried += 1;
        this.deps.logger.warn({ err, type: job.type, attempts: nextAttempts }, 'LLM enrichment job failed — requeued');
      } else {
        this.stats.dropped += 1;
        await this.releaseSeenClaim(job);
        this.deps.logger.warn({ err, type: job.type, attempts: nextAttempts }, 'LLM enrichment job failed — dropped after retries');
      }
    }
  }

  private async processBookmark(doc: BookmarkDoc): Promise<void> {
    await storeSemanticDoc(this.deps.redis, doc);
    const needsEnrichment = !bookmarkAlreadyEnriched(doc);
    const enrichment = needsEnrichment
      ? await this.deps.llm.enrichBookmark({
        url: doc.url,
        title: doc.title,
        description: doc.description,
        tags: doc.tags,
        authorName: doc.author_name,
        source: 'bookmark',
      }).catch((err) => {
        this.deps.logger.warn({ err, eventId: doc.id }, 'LLM bookmark metadata enrichment failed — embedding only');
        return null;
      })
      : null;
    const enrichedDoc = enrichment ? applyBookmarkEnrichment(doc, enrichment) : doc;
    if (enrichment) {
      await this.deps.redis.set(BOOKMARK_PREFIX + doc.id, JSON.stringify(enrichment), 'EX', SEEN_TTL_SECONDS);
      await updateUserSuggestions(this.deps.redis, doc, enrichment);
      await this.deps.meili.upsertBatch([enrichedDoc]);
    }
    const vector = await this.deps.llm.embedText(bookmarkEmbeddingText(enrichedDoc));
    if (vector) {
      await this.deps.redis
        .multi()
        .set(EMBEDDING_PREFIX + doc.id, JSON.stringify(vector))
        .set(SEMANTIC_DOC_PREFIX + doc.id, JSON.stringify(enrichedDoc))
        .sadd(SEMANTIC_SET, doc.id)
        .exec();
      await this.deps.semanticStore?.upsertBookmark(enrichedDoc, vector).catch((err) => {
        this.deps.logger.warn({ err, eventId: doc.id }, 'Qdrant semantic upsert failed');
      });
    }
  }

  private async requeueJob(job: LlmEnrichmentJob, attempts: number, lastError: string): Promise<void> {
    await this.deps.redis.rpush(QUEUE_KEY, JSON.stringify({
      ...job,
      attempts,
      lastError,
    } satisfies LlmEnrichmentJob));
  }

  private async releaseSeenClaim(job: LlmEnrichmentJob): Promise<void> {
    if (job.type === 'bookmark') {
      await this.deps.redis.del(`${SEEN_PREFIX}bookmark:${job.doc.id}`).catch(() => undefined);
    } else if (job.type === 'archive') {
      await this.deps.redis.del(`${SEEN_PREFIX}archive:${job.blobHash}`).catch(() => undefined);
    }
  }

  private async processArchive(job: Extract<LlmEnrichmentJob, { type: 'archive' }>): Promise<void> {
    const summary = await this.deps.llm.summarizeArchive(job.input);
    if (!summary) return;
    await this.deps.redis.set(
      `${ARCHIVE_PREFIX}${job.ownerPubkey}:${job.blobHash}`,
      JSON.stringify(summary),
      'EX',
      SEEN_TTL_SECONDS,
    );
  }

  private async processAlert(job: Extract<LlmEnrichmentJob, { type: 'alert' }>): Promise<void> {
    const digest = await this.deps.llm.summarizeAlert({
      subject: job.subject,
      body: job.body,
      severity: job.severity,
      key: job.key,
    });
    if (!digest) return;
    const key = ALERT_DIGEST_PREFIX + job.id;
    await this.deps.redis
      .multi()
      .set(key, JSON.stringify(digest), 'EX', 60 * 60 * 24 * 7)
      .lpush('dm:llm:alert-digests:recent', JSON.stringify({ id: job.id, key: job.key, ...digest, createdAt: Date.now() }))
      .ltrim('dm:llm:alert-digests:recent', 0, 49)
      .exec();
  }

  private async backfillExistingBookmarks(): Promise<void> {
    if (!this.stats.backfill.enabled || this.stopped) return;
    const done = await this.deps.redis.get(BOOKMARK_BACKFILL_DONE_KEY).catch(() => null);
    if (done) {
      this.stats.backfill.completedAt = Number(done) || null;
      return;
    }
    const lock = await this.deps.redis
      .set(BOOKMARK_BACKFILL_LOCK_KEY, '1', 'EX', 60 * 60, 'NX')
      .catch(() => null);
    if (lock !== 'OK') return;

    this.stats.backfill.running = true;
    try {
      const pageSize = bookmarkBackfillPageSize();
      const delayMs = bookmarkBackfillDelayMs();
      let cursor = await readBackfillCursor(this.deps.redis);
      this.stats.backfill.cursor = cursor;

      while (!this.stopped) {
        const page = await this.deps.meili.documents({ limit: pageSize, offset: cursor });
        if (page.results.length === 0) {
          const completedAt = Date.now();
          await markBackfillComplete(this.deps.redis, completedAt);
          this.stats.backfill.completedAt = completedAt;
          break;
        }

        for (const doc of page.results) {
          const existingVector = await readStoredEmbedding(this.deps.redis, doc.id);
          if (existingVector) {
            await this.upsertExistingSemanticVector(doc, existingVector);
            continue;
          }
          const queued = await queueBookmarkEnrichment(this.deps.redis, doc).catch(() => false);
          if (queued) this.stats.backfill.queued += 1;
        }

        cursor += page.results.length;
        this.stats.backfill.scanned += page.results.length;
        this.stats.backfill.cursor = cursor;
        await this.deps.redis.set(BOOKMARK_BACKFILL_CURSOR_KEY, String(cursor)).catch(() => undefined);

        if (page.results.length < pageSize) {
          const completedAt = Date.now();
          await markBackfillComplete(this.deps.redis, completedAt);
          this.stats.backfill.completedAt = completedAt;
          break;
        }
        await sleep(delayMs);
      }
    } catch (err) {
      this.stats.backfill.lastError = (err as Error).message;
      this.deps.logger.warn({ err }, 'LLM bookmark backfill failed');
    } finally {
      this.stats.backfill.running = false;
      await this.deps.redis.del(BOOKMARK_BACKFILL_LOCK_KEY).catch(() => undefined);
    }
  }

  private async upsertExistingSemanticVector(doc: BookmarkDoc, vector: number[]): Promise<void> {
    if (!this.deps.semanticStore?.enabled) return;
    const storedDoc = await readStoredSemanticDoc(this.deps.redis, doc.id);
    await this.deps.semanticStore.upsertBookmark(storedDoc ?? doc, vector).catch((err) => {
      this.deps.logger.warn({ err, eventId: doc.id }, 'Qdrant semantic backfill upsert failed');
    });
  }
}

export async function enrichMetadataInline(
  llm: DeepInfraClient,
  input: { url: string; title?: string; description?: string; suggestedTags?: string[] },
): Promise<BookmarkEnrichment | null> {
  if (!llm.enabled) return null;
  if (input.title && input.description && (input.suggestedTags?.length ?? 0) >= 3) return null;
  return llm.enrichBookmark({
    url: input.url,
    title: input.title,
    description: input.description,
    tags: input.suggestedTags,
    source: 'metadata',
  }).catch(() => null);
}

export function mergeMetadataEnrichment<T extends { title?: string; description?: string; suggestedTags: string[] }>(
  meta: T,
  enrichment: BookmarkEnrichment | null,
): T {
  if (!enrichment) return meta;
  return {
    ...meta,
    title: meta.title || enrichment.title,
    description: meta.description || enrichment.description || enrichment.summary,
    suggestedTags: mergeTags(meta.suggestedTags, enrichment.tags),
  };
}

export function applyBookmarkEnrichment(doc: BookmarkDoc, enrichment: BookmarkEnrichment): BookmarkDoc {
  return {
    ...doc,
    title: doc.title || enrichment.title || doc.url,
    description: doc.description || enrichment.description || enrichment.summary || '',
    llm_summary: enrichment.summary,
    llm_tags: enrichment.tags,
    llm_category: enrichment.category,
    llm_language: enrichment.language,
    llm_confidence: enrichment.confidence,
  };
}

export async function searchSemanticBookmarks(
  redis: Redis,
  llm: DeepInfraClient,
  query: string,
  opts: SemanticSearchFilters & {
    limit?: number;
    offset?: number;
    scanLimit?: number;
    rerank?: boolean;
    semanticStore?: SemanticVectorStore | null;
  } = {},
): Promise<SearchResult> {
  const started = Date.now();
  const vector = await embedSearchQuery(redis, llm, query);
  if (!vector) return { hits: [], total: 0, query_time_ms: Date.now() - started };
  if (opts.semanticStore?.enabled) {
    const result = await opts.semanticStore.searchBookmarks(vector, opts).catch(() => null);
    if (result) return {
      ...result,
      query_time_ms: Date.now() - started,
    };
  }
  const candidates = await loadSemanticCandidates(redis, opts.scanLimit ?? DEFAULT_SCAN_LIMIT);
  const scored = candidates
    .filter((candidate) => semanticDocMatches(candidate.doc, opts))
    .map((candidate) => ({
      ...candidate,
      score: cosineSimilarity(vector, candidate.embedding),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max((opts.limit ?? 20) + (opts.offset ?? 0), 50));

  if (opts.rerank !== false && scored.length > 1) {
    const rerankScores = await llm.rerank(query, scored.map((row) => bookmarkEmbeddingText(row.doc))).catch(() => null);
    if (rerankScores) {
      scored.forEach((row, index) => {
        row.score = row.score * 0.7 + (rerankScores[index] ?? 0) * 0.3;
      });
      scored.sort((a, b) => b.score - a.score);
    }
  }

  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 20;
  return {
    hits: scored.slice(offset, offset + limit).map((row) => ({
      event_id: row.doc.id,
      score: row.score,
      highlights: {},
      doc: row.doc,
    })),
    total: scored.length,
    query_time_ms: Date.now() - started,
  };
}

function semanticDocMatches(doc: BookmarkDoc, filters: SemanticSearchFilters): boolean {
  if (filters.delistedEventIds?.has(doc.id)) return false;
  if (filters.tags?.length) {
    const tags = new Set(doc.tags.map((tag) => tag.toLowerCase()));
    if (filters.tags.some((tag) => !tags.has(tag.toLowerCase()))) return false;
  }
  if (filters.author && doc.author_pubkey !== filters.author) return false;
  if (filters.site && doc.domain !== filters.site) return false;
  if (filters.filetype && doc.filetype !== filters.filetype) return false;
  if (filters.hasPdf && !doc.has_pdf) return false;
  if (filters.scholarly && !doc.is_scholarly) return false;
  if (filters.after && doc.created_at < filters.after) return false;
  if (filters.before && doc.created_at > filters.before) return false;
  if (filters.minZaps && doc.zap_total < filters.minZaps) return false;
  if (filters.minSaves && doc.save_count < filters.minSaves) return false;
  return true;
}

async function embedSearchQuery(
  redis: Redis,
  llm: DeepInfraClient,
  query: string,
): Promise<number[] | null> {
  const normalized = normalizeSemanticQuery(query);
  if (!normalized) return null;
  const key = semanticQueryEmbeddingKey(llm, normalized);
  const cached = await redis.get(key).catch(() => null);
  const cachedVector = cached ? parseEmbeddingVector(cached) : null;
  if (cachedVector) return cachedVector;

  const vector = await llm.embedText(normalized);
  if (vector) {
    await redis.set(key, JSON.stringify(vector), 'EX', QUERY_EMBEDDING_TTL_SECONDS).catch(() => undefined);
  }
  return vector;
}

function normalizeSemanticQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

function semanticQueryEmbeddingKey(llm: DeepInfraClient, normalizedQuery: string): string {
  const model = llm.modelSummary()?.embedding ?? 'unknown';
  const hash = createHash('sha256')
    .update(model)
    .update('\n')
    .update(normalizedQuery)
    .digest('hex');
  return QUERY_EMBEDDING_PREFIX + hash;
}

function parseEmbeddingVector(raw: string): number[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const vector = parsed.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
    return vector.length > 0 ? vector : null;
  } catch {
    return null;
  }
}

async function loadSemanticCandidates(
  redis: Redis,
  limit: number,
): Promise<Array<{ id: string; embedding: number[]; doc: BookmarkDoc }>> {
  const ids: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.sscan(SEMANTIC_SET, cursor, 'COUNT', 500);
    cursor = next;
    ids.push(...batch);
  } while (cursor !== '0' && ids.length < limit);
  const capped = ids.slice(0, limit);
  if (capped.length === 0) return [];

  const pipeline = redis.pipeline();
  for (const id of capped) {
    pipeline.get(EMBEDDING_PREFIX + id);
    pipeline.get(SEMANTIC_DOC_PREFIX + id);
  }
  const rows = await pipeline.exec();
  if (!rows) return [];
  const out: Array<{ id: string; embedding: number[]; doc: BookmarkDoc }> = [];
  for (let i = 0; i < capped.length; i += 1) {
    const embeddingRaw = rows[i * 2]?.[1];
    const docRaw = rows[i * 2 + 1]?.[1];
    if (typeof embeddingRaw !== 'string' || typeof docRaw !== 'string') continue;
    try {
      const embedding = JSON.parse(embeddingRaw) as number[];
      const doc = JSON.parse(docRaw) as BookmarkDoc;
      if (Array.isArray(embedding) && doc?.id) out.push({ id: capped[i]!, embedding, doc });
    } catch {
      // Ignore corrupt semantic rows; the indexer can refresh them.
    }
  }
  return out;
}

async function readStoredEmbedding(redis: Redis, id: string): Promise<number[] | null> {
  const raw = await redis.get(EMBEDDING_PREFIX + id).catch(() => null);
  return raw ? parseEmbeddingVector(raw) : null;
}

async function readStoredSemanticDoc(redis: Redis, id: string): Promise<BookmarkDoc | null> {
  const raw = await redis.get(SEMANTIC_DOC_PREFIX + id).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isBookmarkDocLike(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isBookmarkDocLike(value: unknown): value is BookmarkDoc {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  return typeof doc.id === 'string' && typeof doc.url === 'string' && Array.isArray(doc.tags);
}

async function storeSemanticDoc(redis: Redis, doc: BookmarkDoc): Promise<void> {
  await redis.set(SEMANTIC_DOC_PREFIX + doc.id, JSON.stringify(doc));
}

export function bookmarkEmbeddingText(doc: BookmarkDoc): string {
  return [
    doc.title,
    doc.description,
    doc.llm_summary,
    ...(doc.tags ?? []),
    ...(doc.llm_tags ?? []),
    doc.llm_category,
    doc.domain,
    doc.url,
  ].filter(Boolean).join('\n');
}

export async function suggestedCollections(
  redis: Redis,
  pubkey: string,
  limit = 12,
): Promise<Array<{ name: string; kind: 'tag' | 'category'; score: number }>> {
  const [tags, categories] = await Promise.all([
    redis.zrevrange(USER_TAGS_PREFIX + pubkey, 0, limit - 1, 'WITHSCORES'),
    redis.zrevrange(USER_CATEGORIES_PREFIX + pubkey, 0, limit - 1, 'WITHSCORES'),
  ]);
  const out: Array<{ name: string; kind: 'tag' | 'category'; score: number }> = [];
  for (let i = 0; i < tags.length; i += 2) {
    out.push({ name: tags[i]!, kind: 'tag', score: Number(tags[i + 1] ?? 0) });
  }
  for (let i = 0; i < categories.length; i += 2) {
    out.push({ name: categories[i]!, kind: 'category', score: Number(categories[i + 1] ?? 0) });
  }
  return out
    .filter((row) => row.name && row.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function mergeTags(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (const tag of [...a, ...b]) {
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= 8) break;
  }
  return out;
}

async function readBackfillCursor(redis: Redis): Promise<number> {
  const raw = await redis.get(BOOKMARK_BACKFILL_CURSOR_KEY).catch(() => null);
  const parsed = Number.parseInt(raw ?? '0', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function markBackfillComplete(redis: Redis, completedAt: number): Promise<void> {
  await redis
    .multi()
    .set(BOOKMARK_BACKFILL_DONE_KEY, String(completedAt))
    .del(BOOKMARK_BACKFILL_CURSOR_KEY)
    .exec();
}

function bookmarkBackfillEnabled(): boolean {
  const value = (process.env.LLM_BACKFILL_EXISTING_BOOKMARKS ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function bookmarkBackfillPageSize(): number {
  const parsed = Number.parseInt(process.env.LLM_BACKFILL_PAGE_SIZE ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BACKFILL_PAGE_SIZE;
  return Math.min(parsed, 500);
}

function bookmarkBackfillDelayMs(): number {
  const parsed = Number.parseInt(process.env.LLM_BACKFILL_DELAY_MS ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_BACKFILL_DELAY_MS;
  return Math.min(parsed, 10_000);
}

function bookmarkAlreadyEnriched(doc: BookmarkDoc): boolean {
  return !!doc.llm_summary || !!doc.llm_category || (doc.llm_tags?.length ?? 0) > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateUserSuggestions(redis: Redis, doc: BookmarkDoc, enrichment: BookmarkEnrichment): Promise<void> {
  const pipeline = redis.pipeline();
  for (const tag of enrichment.tags) {
    pipeline.zincrby(USER_TAGS_PREFIX + doc.author_pubkey, 1, tag);
  }
  if (enrichment.category) {
    pipeline.zincrby(USER_CATEGORIES_PREFIX + doc.author_pubkey, 1, enrichment.category.toLowerCase());
  }
  await pipeline.exec();
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export type StoredArchiveSummary = ArchiveSummary;
export type StoredAlertDigest = AlertDigest;
