import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';

import { DeepInfraClient, DeepInfraModelPolicyError, deepInfraConfigFromEnv } from '@src/llm.js';
import {
  LlmEnrichmentWorker,
  applyBookmarkEnrichment,
  mergeMetadataEnrichment,
  searchSemanticBookmarks,
} from '@src/llm-enrichment.js';
import type { BookmarkDoc } from '@src/search.js';
import type { SemanticVectorStore } from '@src/semantic-vector-store.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('deepInfraConfigFromEnv', () => {
  it('returns null without a token', () => {
    expect(deepInfraConfigFromEnv({})).toBeNull();
  });

  it('uses the DeepInfra model defaults with a token', () => {
    const config = deepInfraConfigFromEnv({ DEEPINFRA_TOKEN: 'token' });

    expect(config).toMatchObject({
      enrichmentModel: 'deepseek-ai/DeepSeek-V4-Flash',
      rescueModel: 'deepseek-ai/DeepSeek-V4-Pro',
      embeddingModel: 'Qwen/Qwen3-Embedding-8B',
      rerankModel: 'Qwen/Qwen3-Reranker-4B',
    });
  });

  it('lets individual models be overridden with approved open-source models', () => {
    const config = deepInfraConfigFromEnv({
      DEEPINFRA_TOKEN: 'token',
      DEEPINFRA_CHAT_MODEL: 'deepseek-ai/DeepSeek-V4-Pro',
      DEEPINFRA_RESCUE_MODEL: 'deepseek-ai/DeepSeek-V4-Flash',
      DEEPINFRA_EMBEDDING_MODEL: 'Qwen/Qwen3-Embedding-4B',
      DEEPINFRA_RERANK_MODEL: 'Qwen/Qwen3-Reranker-8B',
    });

    expect(config?.enrichmentModel).toBe('deepseek-ai/DeepSeek-V4-Pro');
    expect(config?.rescueModel).toBe('deepseek-ai/DeepSeek-V4-Flash');
    expect(config?.embeddingModel).toBe('Qwen/Qwen3-Embedding-4B');
    expect(config?.rerankModel).toBe('Qwen/Qwen3-Reranker-8B');
  });

  it('rejects unapproved model overrides', () => {
    expect(() => deepInfraConfigFromEnv({
      DEEPINFRA_TOKEN: 'token',
      DEEPINFRA_CHAT_MODEL: 'closed-model',
    })).toThrow(DeepInfraModelPolicyError);
  });
});

describe('DeepInfraClient', () => {
  it('requests strict JSON-schema output for bookmark enrichment', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.response_format).toMatchObject({
        type: 'json_schema',
        json_schema: { name: 'bookmark_enrichment', strict: true },
      });
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              title: 'Fetched title',
              description: 'Fetched description',
              summary: 'Short summary',
              tags: ['AI Research', 'machine learning', 'ai'],
              category: 'Research',
              language: 'en',
              confidence: 0.9,
            }),
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new DeepInfraClient(deepInfraConfigFromEnv({ DEEPINFRA_TOKEN: 'token' }));
    const result = await client.enrichBookmark({ url: 'https://example.com/post' });

    expect(result).toMatchObject({
      title: 'Fetched title',
      description: 'Fetched description',
      summary: 'Short summary',
      tags: ['ai', 'research', 'machine', 'learning'],
      category: 'Research',
      language: 'en',
      confidence: 0.9,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parses embedding and rerank responses', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/embeddings')) {
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ scores: [0.8, 0.1] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new DeepInfraClient(deepInfraConfigFromEnv({ DEEPINFRA_TOKEN: 'token' }));

    await expect(client.embedText('hello')).resolves.toEqual([0.1, 0.2, 0.3]);
    await expect(client.rerank('query', ['a', 'b'])).resolves.toEqual([0.8, 0.1]);
  });
});

describe('LLM enrichment merge helpers', () => {
  it('fills missing metadata without overwriting deterministic fields', () => {
    const merged = mergeMetadataEnrichment(
      { title: 'Existing title', suggestedTags: ['web'] },
      {
        title: 'LLM title',
        description: 'LLM description',
        summary: 'LLM summary',
        tags: ['ai', 'web'],
        category: 'technology',
        language: 'en',
        confidence: 0.8,
      },
    );

    expect(merged.title).toBe('Existing title');
    expect(merged.description).toBe('LLM description');
    expect(merged.suggestedTags).toEqual(['web', 'ai']);
  });

  it('keeps user-authored bookmark tags separate from LLM tags', () => {
    const doc: BookmarkDoc = {
      id: 'event',
      url: 'https://example.com',
      title: '',
      description: '',
      tags: ['manual'],
      author_pubkey: 'a'.repeat(64),
      domain: 'example.com',
      has_pdf: false,
      is_scholarly: false,
      created_at: 1,
      zap_total: 0,
      save_count: 0,
    };

    const enriched = applyBookmarkEnrichment(doc, {
      title: 'LLM title',
      description: 'LLM description',
      summary: 'LLM summary',
      tags: ['ai'],
      category: 'technology',
      language: 'en',
      confidence: 0.7,
    });

    expect(enriched.tags).toEqual(['manual']);
    expect(enriched.llm_tags).toEqual(['ai']);
    expect(enriched.title).toBe('LLM title');
  });
});

describe('LLM bookmark backfill', () => {
  it('is disabled unless explicitly enabled', () => {
    const worker = new LlmEnrichmentWorker({
      redis: new FakeRedis() as unknown as Redis,
      meili: new FakeMeili([]) as never,
      llm: fakeLlmClient() as never,
      logger: quietLogger,
    });

    expect(worker.stats.backfill.enabled).toBe(false);
  });

  it('queues existing bookmarks that are missing embeddings even when already enriched', async () => {
    vi.stubEnv('LLM_BACKFILL_EXISTING_BOOKMARKS', '1');
    vi.stubEnv('LLM_BACKFILL_DELAY_MS', '0');
    const redis = new FakeRedis();
    const worker = new LlmEnrichmentWorker({
      redis: redis as unknown as Redis,
      meili: new FakeMeili([
        bookmarkDoc({ id: 'needs-llm' }),
        bookmarkDoc({ id: 'already-enriched', llm_summary: 'done' }),
      ]) as never,
      llm: fakeLlmClient() as never,
      logger: quietLogger,
    });
    const harness = worker as unknown as {
      stopped: boolean;
      backfillExistingBookmarks: () => Promise<void>;
    };

    harness.stopped = false;
    await harness.backfillExistingBookmarks();

    expect(worker.stats.backfill).toMatchObject({
      enabled: true,
      running: false,
      scanned: 2,
      queued: 2,
      cursor: 2,
    });
    expect(redis.queue).toHaveLength(2);
    expect(JSON.parse(redis.queue[0]!)).toMatchObject({
      type: 'bookmark',
      doc: { id: 'needs-llm' },
    });
    expect(JSON.parse(redis.queue[1]!)).toMatchObject({
      type: 'bookmark',
      doc: { id: 'already-enriched' },
    });
    await expect(redis.get('dm:llm:backfill:bookmarks:done')).resolves.toMatch(/^\d+$/);
  });

  it('requeues failed embedding jobs with an attempt count', async () => {
    const redis = new FakeRedis();
    const worker = new LlmEnrichmentWorker({
      redis: redis as unknown as Redis,
      meili: new FakeMeili([]) as never,
      llm: failingLlmClient() as never,
      logger: quietLogger,
    });
    const harness = worker as unknown as {
      processRaw: (raw: string) => Promise<void>;
    };

    await harness.processRaw(JSON.stringify({
      type: 'bookmark',
      doc: bookmarkDoc({ id: 'retry-me' }),
      queuedAt: 1,
    }));

    expect(worker.stats.failed).toBe(1);
    expect(worker.stats.retried).toBe(1);
    expect(worker.stats.dropped).toBe(0);
    expect(redis.queue).toHaveLength(1);
    expect(JSON.parse(redis.queue[0]!)).toMatchObject({
      type: 'bookmark',
      attempts: 1,
      lastError: 'DeepInfra timeout',
      doc: { id: 'retry-me' },
    });
  });

  it('still embeds a bookmark when metadata enrichment times out', async () => {
    const redis = new FakeRedis();
    const worker = new LlmEnrichmentWorker({
      redis: redis as unknown as Redis,
      meili: new FakeMeili([]) as never,
      llm: metadataTimeoutLlmClient() as never,
      logger: quietLogger,
    });
    const harness = worker as unknown as {
      processRaw: (raw: string) => Promise<void>;
    };

    await harness.processRaw(JSON.stringify({
      type: 'bookmark',
      doc: bookmarkDoc({ id: 'embed-anyway' }),
      queuedAt: 1,
    }));

    expect(worker.stats.processed).toBe(1);
    expect(worker.stats.failed).toBe(0);
    expect(redis.queue).toHaveLength(0);
    await expect(redis.get('dm:llm:embedding:bookmark:embed-anyway')).resolves.toBe('[0.1,0.2]');
  });


  it('drops exhausted jobs and releases the seen claim for a later backfill pass', async () => {
    const redis = new FakeRedis();
    await redis.set('dm:llm:seen:bookmark:drop-me', '1');
    const worker = new LlmEnrichmentWorker({
      redis: redis as unknown as Redis,
      meili: new FakeMeili([]) as never,
      llm: failingLlmClient() as never,
      logger: quietLogger,
    });
    const harness = worker as unknown as {
      processRaw: (raw: string) => Promise<void>;
    };

    await harness.processRaw(JSON.stringify({
      type: 'bookmark',
      doc: bookmarkDoc({ id: 'drop-me' }),
      queuedAt: 1,
      attempts: 2,
    }));

    expect(worker.stats.failed).toBe(1);
    expect(worker.stats.retried).toBe(0);
    expect(worker.stats.dropped).toBe(1);
    expect(redis.queue).toHaveLength(0);
    await expect(redis.get('dm:llm:seen:bookmark:drop-me')).resolves.toBeNull();
  });
});

describe('semantic bookmark search', () => {
  it('caches query embeddings in Redis by normalized query', async () => {
    const redis = new FakeRedis();
    const doc = bookmarkDoc({
      id: 'semantic-hit',
      title: 'Nostr search',
      description: 'Public bookmark search',
    });
    await redis.set('dm:llm:embedding:bookmark:semantic-hit', JSON.stringify([1, 0]));
    await redis.set('dm:llm:semantic-doc:semantic-hit', JSON.stringify(doc));
    await redis.sadd('dm:llm:semantic-bookmarks', 'semantic-hit');
    const llm = semanticLlmClient();

    const first = await searchSemanticBookmarks(redis as unknown as Redis, llm as never, '  Nostr   Search ', {
      limit: 1,
      rerank: false,
    });
    const second = await searchSemanticBookmarks(redis as unknown as Redis, llm as never, 'nostr search', {
      limit: 1,
      rerank: false,
    });

    expect(first.hits[0]?.event_id).toBe('semantic-hit');
    expect(second.hits[0]?.event_id).toBe('semantic-hit');
    expect(llm.embedText).toHaveBeenCalledTimes(1);
  });

  it('filters delisted bookmarks in the Redis semantic fallback', async () => {
    const redis = new FakeRedis();
    const blocked = bookmarkDoc({ id: 'blocked-hit', title: 'Nostr blocked' });
    const allowed = bookmarkDoc({ id: 'allowed-hit', title: 'Nostr allowed' });
    await redis.set('dm:llm:embedding:bookmark:blocked-hit', JSON.stringify([1, 0]));
    await redis.set('dm:llm:semantic-doc:blocked-hit', JSON.stringify(blocked));
    await redis.set('dm:llm:embedding:bookmark:allowed-hit', JSON.stringify([1, 0]));
    await redis.set('dm:llm:semantic-doc:allowed-hit', JSON.stringify(allowed));
    await redis.sadd('dm:llm:semantic-bookmarks', 'blocked-hit', 'allowed-hit');

    const result = await searchSemanticBookmarks(redis as unknown as Redis, semanticLlmClient() as never, 'nostr', {
      limit: 10,
      rerank: false,
      delistedEventIds: new Set(['blocked-hit']),
    });

    expect(result.hits.map((hit) => hit.event_id)).toEqual(['allowed-hit']);
  });

  it('respects an empty Qdrant result instead of falling back to Redis', async () => {
    const redis = new FakeRedis();
    const doc = bookmarkDoc({ id: 'redis-hit', title: 'Nostr Redis fallback' });
    await redis.set('dm:llm:embedding:bookmark:redis-hit', JSON.stringify([1, 0]));
    await redis.set('dm:llm:semantic-doc:redis-hit', JSON.stringify(doc));
    await redis.sadd('dm:llm:semantic-bookmarks', 'redis-hit');
    const semanticStore: SemanticVectorStore = {
      enabled: true,
      upsertBookmark: vi.fn(async () => undefined),
      healthy: vi.fn(async () => true),
      searchBookmarks: vi.fn(async () => ({ hits: [], total: 0, query_time_ms: 3 })),
    };

    const result = await searchSemanticBookmarks(redis as unknown as Redis, semanticLlmClient() as never, 'nostr', {
      semanticStore,
      rerank: false,
    });

    expect(result.hits).toEqual([]);
    expect(semanticStore.searchBookmarks).toHaveBeenCalledTimes(1);
  });

  it('falls back to Redis vectors when Qdrant is unavailable', async () => {
    const redis = new FakeRedis();
    const doc = bookmarkDoc({ id: 'redis-hit', title: 'Nostr Redis fallback' });
    await redis.set('dm:llm:embedding:bookmark:redis-hit', JSON.stringify([1, 0]));
    await redis.set('dm:llm:semantic-doc:redis-hit', JSON.stringify(doc));
    await redis.sadd('dm:llm:semantic-bookmarks', 'redis-hit');
    const semanticStore: SemanticVectorStore = {
      enabled: true,
      upsertBookmark: vi.fn(async () => undefined),
      healthy: vi.fn(async () => false),
      searchBookmarks: vi.fn(async () => {
        throw new Error('qdrant unavailable');
      }),
    };

    const result = await searchSemanticBookmarks(redis as unknown as Redis, semanticLlmClient() as never, 'nostr', {
      semanticStore,
      rerank: false,
    });

    expect(result.hits[0]?.event_id).toBe('redis-hit');
  });
});

function bookmarkDoc(overrides: Partial<BookmarkDoc> = {}): BookmarkDoc {
  return {
    id: 'event',
    url: 'https://example.com',
    title: 'Example',
    description: '',
    tags: [],
    author_pubkey: 'a'.repeat(64),
    domain: 'example.com',
    has_pdf: false,
    is_scholarly: false,
    created_at: 1,
    zap_total: 0,
    save_count: 0,
    ...overrides,
  };
}

function fakeLlmClient(): Pick<DeepInfraClient, 'enabled' | 'modelSummary'> {
  return {
    enabled: true,
    modelSummary: () => ({ enrichment: 'test' }),
  };
}

function failingLlmClient(): Pick<DeepInfraClient, 'enabled' | 'modelSummary' | 'enrichBookmark' | 'embedText'> {
  return {
    enabled: true,
    modelSummary: () => ({ enrichment: 'test', embedding: 'test' }),
    enrichBookmark: vi.fn(async () => null),
    embedText: vi.fn(async () => {
      throw new Error('DeepInfra timeout');
    }),
  };
}

function metadataTimeoutLlmClient(): Pick<DeepInfraClient, 'enabled' | 'modelSummary' | 'enrichBookmark' | 'embedText'> {
  return {
    enabled: true,
    modelSummary: () => ({ enrichment: 'test', embedding: 'test' }),
    enrichBookmark: vi.fn(async () => {
      throw new Error('DeepInfra timeout');
    }),
    embedText: vi.fn(async () => [0.1, 0.2]),
  };
}

function semanticLlmClient(): Pick<DeepInfraClient, 'enabled' | 'modelSummary' | 'embedText' | 'rerank'> {
  return {
    enabled: true,
    modelSummary: () => ({ enrichment: 'test', embedding: 'test-embedding', rerank: 'test-rerank' }),
    embedText: vi.fn(async () => [1, 0]),
    rerank: vi.fn(async () => [1]),
  };
}

const quietLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

class FakeMeili {
  constructor(private readonly docs: BookmarkDoc[]) {}

  async documents({ limit = 100, offset = 0 }: { limit?: number; offset?: number } = {}) {
    return {
      results: this.docs.slice(offset, offset + limit),
      limit,
      offset,
      total: this.docs.length,
    };
  }
}

class FakeRedis {
  readonly queue: string[] = [];
  private readonly values = new Map<string, string>();
  private readonly sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    if (args.includes('NX') && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) added += 1;
      set.add(member);
    }
    this.sets.set(key, set);
    return added;
  }

  async sscan(key: string): Promise<[string, string[]]> {
    return ['0', [...(this.sets.get(key) ?? new Set<string>())]];
  }

  async rpush(_key: string, value: string): Promise<number> {
    this.queue.push(value);
    return this.queue.length;
  }

  multi(): FakeRedisPipeline {
    return new FakeRedisPipeline(this);
  }

  pipeline(): FakeRedisPipeline {
    return new FakeRedisPipeline(this);
  }
}

class FakeRedisPipeline {
  private readonly ops: Array<() => Promise<unknown>> = [];

  constructor(private readonly redis: FakeRedis) {}

  get(key: string): this {
    this.ops.push(() => this.redis.get(key));
    return this;
  }

  set(key: string, value: string): this {
    this.ops.push(() => this.redis.set(key, value));
    return this;
  }

  sadd(key: string, value: string): this {
    this.ops.push(() => this.redis.sadd(key, value));
    return this;
  }

  del(key: string): this {
    this.ops.push(() => this.redis.del(key));
    return this;
  }

  async exec(): Promise<Array<[null, unknown]>> {
    const out: Array<[null, unknown]> = [];
    for (const op of this.ops) out.push([null, await op()]);
    return out;
  }
}
