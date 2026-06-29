import { createHash } from 'node:crypto';
import type { BookmarkDoc, SearchResult } from './search.js';

const QDRANT_COUNT_TIMEOUT_MS = 250;

export interface SemanticSearchFilters {
  tags?: string[];
  author?: string;
  site?: string;
  filetype?: string;
  hasPdf?: boolean;
  scholarly?: boolean;
  after?: number;
  before?: number;
  minZaps?: number;
  minSaves?: number;
  delistedEventIds?: Set<string>;
}

export interface SemanticVectorStoreStats {
  provider: 'qdrant';
  enabled: boolean;
  healthy: boolean;
  collection: string;
  pointsCount: number | null;
  indexedVectorsCount: number | null;
}

export interface SemanticVectorStore {
  readonly enabled: boolean;
  upsertBookmark(doc: BookmarkDoc, vector: number[]): Promise<void>;
  searchBookmarks(
    vector: number[],
    opts: SemanticSearchFilters & { limit?: number; offset?: number },
  ): Promise<SearchResult>;
  healthy(): Promise<boolean>;
  stats?(): Promise<SemanticVectorStoreStats>;
}

export interface QdrantConfig {
  url: string;
  apiKey?: string;
  collection: string;
  timeoutMs: number;
}

export interface QdrantLogger {
  warn: (...a: unknown[]) => void;
}

export class SemanticVectorStoreNotReadyError extends Error {
  constructor(message = 'semantic vector store is not ready') {
    super(message);
    this.name = 'SemanticVectorStoreNotReadyError';
  }
}

export function qdrantConfigFromEnv(env: NodeJS.ProcessEnv = process.env): QdrantConfig | null {
  if (env.QDRANT_ENABLED === '0' || env.QDRANT_ENABLED === 'false') return null;
  const url = (env.QDRANT_URL ?? '').trim().replace(/\/$/, '');
  if (!url) return null;
  return {
    url,
    apiKey: (env.QDRANT_API_KEY ?? '').trim() || undefined,
    collection: sanitizeCollectionName(env.QDRANT_COLLECTION ?? 'deepmarks_bookmarks_semantic'),
    timeoutMs: Number.parseInt(env.QDRANT_TIMEOUT_MS ?? '5000', 10) || 5000,
  };
}

export class QdrantSemanticStore implements SemanticVectorStore {
  readonly enabled = true;
  private readyDimension: number | null = null;
  private payloadIndexesEnsured = false;
  private lastKnownPointCount: number | null = null;

  constructor(
    private readonly config: QdrantConfig,
    private readonly logger: QdrantLogger = console,
  ) {}

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.url}/readyz`, { headers: this.headers() });
      return res.ok;
    } catch {
      return false;
    }
  }

  async upsertBookmark(doc: BookmarkDoc, vector: number[]): Promise<void> {
    if (vector.length === 0) return;
    await this.ensureCollection(vector.length);
    await this.req('PUT', `/collections/${encodeURIComponent(this.config.collection)}/points?wait=true`, {
      points: [{
        id: qdrantPointIdForEventId(doc.id),
        vector,
        payload: bookmarkPayload(doc),
      }],
    });
    this.lastKnownPointCount = Math.max(this.lastKnownPointCount ?? 0, 1);
  }

  async searchBookmarks(
    vector: number[],
    opts: SemanticSearchFilters & { limit?: number; offset?: number },
  ): Promise<SearchResult> {
    const started = Date.now();
    if (vector.length === 0) return { hits: [], total: 0, query_time_ms: 0 };
    await this.ensureCollection(vector.length);
    if (this.lastKnownPointCount === 0) {
      throw new SemanticVectorStoreNotReadyError('qdrant collection has no bookmark vectors');
    }
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 20;
    const filter = qdrantFilter(opts);
    const [result, count] = await Promise.all([
      this.req<QdrantQueryResponse>(
        'POST',
        `/collections/${encodeURIComponent(this.config.collection)}/points/query`,
        {
          query: vector,
          filter,
          limit,
          offset,
          with_payload: true,
          with_vector: false,
        },
      ),
      this.req<QdrantCountResponse>(
        'POST',
        `/collections/${encodeURIComponent(this.config.collection)}/points/count`,
        {
          filter,
          exact: false,
        },
        Math.min(this.config.timeoutMs, QDRANT_COUNT_TIMEOUT_MS),
      ).catch(() => null),
    ]);
    const points = qdrantPoints(result);
    const countTotal = qdrantCount(count);
    const windowTotal = offset + points.length;
    const fallbackTotal = filter
      ? windowTotal
      : Math.max(this.lastKnownPointCount ?? 0, windowTotal);
    const total = countTotal === null
      ? fallbackTotal
      : Math.max(countTotal, windowTotal);
    return {
      hits: points.map((point) => ({
        event_id: qdrantPayloadDoc(point.payload)?.id ?? String(point.payload?.event_id ?? point.id),
        score: typeof point.score === 'number' ? point.score : 0,
        highlights: {},
        doc: qdrantPayloadDoc(point.payload) ?? payloadToBookmarkDoc(point.payload),
      })).filter((hit) => !!hit.doc.id),
      total,
      query_time_ms: Date.now() - started,
    };
  }

  async stats(): Promise<SemanticVectorStoreStats> {
    const [healthy, collection] = await Promise.all([
      this.healthy(),
      this.req<QdrantCollectionResponse>(
        'GET',
        `/collections/${encodeURIComponent(this.config.collection)}`,
      ).catch(() => null),
    ]);
    if (collection) {
      const pointsCount = qdrantPointsCount(collection);
      if (pointsCount !== null) this.lastKnownPointCount = pointsCount;
    }
    return {
      provider: 'qdrant',
      enabled: true,
      healthy,
      collection: this.config.collection,
      pointsCount: collection ? qdrantPointsCount(collection) : null,
      indexedVectorsCount: collection ? qdrantIndexedVectorsCount(collection) : null,
    };
  }

  private async ensureCollection(dimension: number): Promise<void> {
    if (this.readyDimension === dimension) return;
    const path = `/collections/${encodeURIComponent(this.config.collection)}`;
    const existing = await this.req<QdrantCollectionResponse>('GET', path).catch((err) => {
      if (String(err).includes('404')) return null;
      throw err;
    });

    if (!existing) {
      await this.req('PUT', path, {
        vectors: { size: dimension, distance: 'Cosine' },
      });
      this.lastKnownPointCount = 0;
    } else {
      const existingDim = qdrantVectorSize(existing);
      if (existingDim && existingDim !== dimension) {
        throw new Error(`qdrant collection dimension mismatch: expected ${dimension}, found ${existingDim}`);
      }
      const existingCount = qdrantPointsCount(existing);
      if (existingCount !== null) this.lastKnownPointCount = existingCount;
    }

    this.readyDimension = dimension;
    if (!this.payloadIndexesEnsured) {
      this.payloadIndexesEnsured = true;
      await this.ensurePayloadIndexes();
    }
  }

  private async ensurePayloadIndexes(): Promise<void> {
    const indexes: Array<[string, string]> = [
      ['event_id', 'keyword'],
      ['tags', 'keyword'],
      ['author_pubkey', 'keyword'],
      ['domain', 'keyword'],
      ['filetype', 'keyword'],
      ['llm_category', 'keyword'],
      ['llm_language', 'keyword'],
      ['has_pdf', 'bool'],
      ['is_scholarly', 'bool'],
      ['created_at', 'integer'],
      ['zap_total', 'integer'],
      ['save_count', 'integer'],
    ];
    for (const [field_name, field_schema] of indexes) {
      await this.req('PUT', `/collections/${encodeURIComponent(this.config.collection)}/index`, {
        field_name,
        field_schema,
      }).catch((err) => {
        this.logger.warn({ err, field_name, collection: this.config.collection }, 'Qdrant payload index creation failed');
      });
    }
  }

  private async req<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.config.timeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.config.url}${path}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`qdrant ${method} ${path} ${res.status}: ${text}`);
      }
      return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.config.apiKey ? { 'api-key': this.config.apiKey } : {}),
    };
  }
}

export function qdrantPointIdForEventId(eventId: string): string {
  const hex = /^[0-9a-f]{32,}$/i.test(eventId)
    ? eventId.toLowerCase().slice(0, 32)
    : createHash('sha256').update(eventId).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function bookmarkPayload(doc: BookmarkDoc): Record<string, unknown> {
  return {
    event_id: doc.id,
    doc,
    url: doc.url,
    title: doc.title,
    tags: doc.tags,
    author_pubkey: doc.author_pubkey,
    domain: doc.domain,
    filetype: doc.filetype ?? '',
    has_pdf: doc.has_pdf,
    is_scholarly: doc.is_scholarly,
    created_at: doc.created_at,
    zap_total: doc.zap_total,
    save_count: doc.save_count,
    llm_category: doc.llm_category ?? '',
    llm_language: doc.llm_language ?? '',
  };
}

function qdrantFilter(filters: SemanticSearchFilters): Record<string, unknown> | undefined {
  const must: Array<Record<string, unknown>> = [];
  const must_not: Array<Record<string, unknown>> = [];
  for (const tag of filters.tags ?? []) must.push(matchCondition('tags', tag));
  if (filters.author) must.push(matchCondition('author_pubkey', filters.author));
  if (filters.site) must.push(matchCondition('domain', filters.site));
  if (filters.filetype) must.push(matchCondition('filetype', filters.filetype));
  if (filters.hasPdf) must.push(matchCondition('has_pdf', true));
  if (filters.scholarly) must.push(matchCondition('is_scholarly', true));
  const createdRange: Record<string, number> = {};
  if (filters.after) createdRange.gte = filters.after;
  if (filters.before) createdRange.lte = filters.before;
  if (Object.keys(createdRange).length > 0) must.push({ key: 'created_at', range: createdRange });
  if (filters.minZaps) must.push({ key: 'zap_total', range: { gte: filters.minZaps } });
  if (filters.minSaves) must.push({ key: 'save_count', range: { gte: filters.minSaves } });
  if (filters.delistedEventIds?.size) {
    must_not.push({ key: 'event_id', match: { any: [...filters.delistedEventIds] } });
  }
  if (must.length === 0 && must_not.length === 0) return undefined;
  return {
    ...(must.length > 0 ? { must } : {}),
    ...(must_not.length > 0 ? { must_not } : {}),
  };
}

function matchCondition(key: string, value: string | boolean): Record<string, unknown> {
  return { key, match: { value } };
}

function sanitizeCollectionName(raw: string): string {
  return raw.trim().replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'deepmarks_bookmarks_semantic';
}

interface QdrantQueryResponse {
  result?: unknown;
  time?: number;
}

interface QdrantCollectionResponse {
  result?: {
    points_count?: number;
    indexed_vectors_count?: number;
    config?: {
      params?: {
        vectors?: { size?: number } | Record<string, { size?: number }>;
      };
    };
  };
}

interface QdrantCountResponse {
  result?: {
    count?: number;
  };
}

interface QdrantPoint {
  id: string | number;
  score?: number;
  payload?: Record<string, unknown>;
}

function qdrantPoints(response: QdrantQueryResponse): QdrantPoint[] {
  const result = response.result as unknown;
  if (Array.isArray(result)) return result.filter(isQdrantPoint);
  if (result && typeof result === 'object' && Array.isArray((result as { points?: unknown[] }).points)) {
    return ((result as { points: unknown[] }).points).filter(isQdrantPoint);
  }
  return [];
}

function isQdrantPoint(value: unknown): value is QdrantPoint {
  return !!value && typeof value === 'object' && ('id' in value);
}

function qdrantPayloadDoc(payload: Record<string, unknown> | undefined): BookmarkDoc | null {
  const doc = payload?.doc;
  return isBookmarkDocLike(doc) ? doc : null;
}

function payloadToBookmarkDoc(payload: Record<string, unknown> | undefined): BookmarkDoc {
  const eventId = typeof payload?.event_id === 'string' ? payload.event_id : '';
  return {
    id: eventId,
    url: typeof payload?.url === 'string' ? payload.url : '',
    title: typeof payload?.title === 'string' ? payload.title : '',
    description: '',
    tags: Array.isArray(payload?.tags) ? payload.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    author_pubkey: typeof payload?.author_pubkey === 'string' ? payload.author_pubkey : '',
    domain: typeof payload?.domain === 'string' ? payload.domain : '',
    filetype: typeof payload?.filetype === 'string' ? payload.filetype : undefined,
    has_pdf: payload?.has_pdf === true,
    is_scholarly: payload?.is_scholarly === true,
    created_at: typeof payload?.created_at === 'number' ? payload.created_at : 0,
    zap_total: typeof payload?.zap_total === 'number' ? payload.zap_total : 0,
    save_count: typeof payload?.save_count === 'number' ? payload.save_count : 0,
  };
}

function isBookmarkDocLike(value: unknown): value is BookmarkDoc {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  return typeof doc.id === 'string' && typeof doc.url === 'string' && Array.isArray(doc.tags);
}

function qdrantVectorSize(response: QdrantCollectionResponse): number | null {
  const vectors = response.result?.config?.params?.vectors;
  if (!vectors || typeof vectors !== 'object') return null;
  if ('size' in vectors && typeof vectors.size === 'number') return vectors.size;
  const first = Object.values(vectors)[0];
  return first && typeof first === 'object' && typeof first.size === 'number' ? first.size : null;
}

function qdrantCount(response: QdrantCountResponse | null): number | null {
  const count = response?.result?.count;
  return typeof count === 'number' && Number.isFinite(count) ? count : null;
}

function qdrantPointsCount(response: QdrantCollectionResponse): number | null {
  const count = response.result?.points_count;
  return typeof count === 'number' && Number.isFinite(count) ? count : null;
}

function qdrantIndexedVectorsCount(response: QdrantCollectionResponse): number | null {
  const count = response.result?.indexed_vectors_count;
  return typeof count === 'number' && Number.isFinite(count) ? count : null;
}
