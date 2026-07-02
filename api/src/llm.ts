import { z } from 'zod';
import { normalizeTag } from './metadata.js';

const DEFAULT_CHAT_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';
const DEFAULT_RESCUE_MODEL = 'deepseek-ai/DeepSeek-V4-Pro';
const DEFAULT_EMBEDDING_MODEL = 'Qwen/Qwen3-Embedding-8B';
const DEFAULT_RERANK_MODEL = 'Qwen/Qwen3-Reranker-4B';
const DEFAULT_BASE_URL = 'https://api.deepinfra.com/v1/openai';
const DEFAULT_NATIVE_BASE_URL = 'https://api.deepinfra.com/v1/inference';
// Optional fast fallback for chat completions when DeepInfra times out / errors
// (Cerebras). gpt-oss-120b is open-weight, supports strict json_schema, and
// returns in ~1s with low reasoning effort — so a DeepInfra spike/incident
// becomes invisible instead of dropping the job.
const DEFAULT_CHAT_FALLBACK_BASE_URL = 'https://api.cerebras.ai/v1';
const DEFAULT_CHAT_FALLBACK_MODEL = 'gpt-oss-120b';
const DEFAULT_TIMEOUT_MS = 8_000;
// Chat completions normally return in 1–3s, but DeepInfra has occasional
// latency spikes, and an 8s cap turned those spikes into dropped enrichment
// jobs (intermittent, not constant — the worker only logs the failures, so
// successes are silent). A 20s ceiling rides out the spikes without being
// absurd; healthy calls still return in a few seconds. Embeddings/rerank keep
// the shorter DEFAULT_TIMEOUT_MS, and latency-sensitive inline calls
// (save-form autofill) pass a short per-call override.
const DEFAULT_CHAT_TIMEOUT_MS = 20_000;
export const DEEPINFRA_MODEL_POLICY = 'open-source-only';

const OPEN_SOURCE_CHAT_MODELS = new Set([
  'deepseek-ai/DeepSeek-V4-Flash',
  'deepseek-ai/DeepSeek-V4-Pro',
  // Cerebras chat-fallback options — both open-weight.
  'gpt-oss-120b',
  'zai-glm-4.7',
]);
const OPEN_SOURCE_EMBEDDING_MODELS = new Set([
  'Qwen/Qwen3-Embedding-0.6B',
  'Qwen/Qwen3-Embedding-4B',
  'Qwen/Qwen3-Embedding-8B',
]);
const OPEN_SOURCE_RERANK_MODELS = new Set([
  'Qwen/Qwen3-Reranker-0.6B',
  'Qwen/Qwen3-Reranker-4B',
  'Qwen/Qwen3-Reranker-8B',
]);

export class DeepInfraModelPolicyError extends Error {
  constructor(role: string, model: string) {
    super(`DeepInfra ${role} model "${model}" is not approved by the ${DEEPINFRA_MODEL_POLICY} policy`);
    this.name = 'DeepInfraModelPolicyError';
  }
}

export interface DeepInfraConfig {
  token: string;
  baseUrl: string;
  nativeBaseUrl: string;
  enrichmentModel: string;
  summaryModel: string;
  importModel: string;
  alertModel: string;
  rescueModel: string;
  embeddingModel: string;
  rerankModel: string;
  timeoutMs: number;
  chatTimeoutMs: number;
  chatFallbackBaseUrl: string | null;
  chatFallbackToken: string | null;
  chatFallbackModel: string;
}

export interface BookmarkEnrichmentInput {
  url: string;
  title?: string;
  description?: string;
  tags?: string[];
  authorName?: string;
  source?: 'metadata' | 'bookmark' | 'archive' | 'import';
}

export interface BookmarkEnrichment {
  title?: string;
  description?: string;
  summary?: string;
  tags: string[];
  category?: string;
  language?: string;
  confidence: number;
}

export interface ArchiveSummaryInput {
  url: string;
  title?: string;
  description?: string;
  kind?: string;
  contentType?: string;
  fileName?: string;
  videoTitle?: string;
  videoChannel?: string;
  tags?: string[];
}

export interface ArchiveSummary {
  summary?: string;
  tags: string[];
  category?: string;
  language?: string;
  confidence: number;
}

export interface ImportCleanupItem {
  id?: string;
  url: string;
  title?: string;
  description?: string;
  tags?: string[];
}

export interface ImportCleanupSuggestion {
  id?: string;
  url: string;
  title?: string;
  description?: string;
  tags: string[];
  category?: string;
  confidence: number;
}

export interface AlertDigest {
  summary: string;
  likelyCause?: string;
  action?: string;
  severity: 'info' | 'warning' | 'critical';
  confidence: number;
}

export interface ArchiveRescueInput {
  url: string;
  failureReason: string;
  error?: string;
}

export interface ArchiveRescueSuggestion {
  candidates: Array<{
    url: string;
    reason: string;
    confidence: number;
  }>;
  searchQueries: string[];
}

const BookmarkEnrichmentSchema = z.object({
  title: z.string(),
  description: z.string(),
  summary: z.string(),
  tags: z.array(z.string()).max(8),
  category: z.string(),
  language: z.string(),
  confidence: z.number().min(0).max(1),
});

const ArchiveSummarySchema = z.object({
  summary: z.string(),
  tags: z.array(z.string()).max(8),
  category: z.string(),
  language: z.string(),
  confidence: z.number().min(0).max(1),
});

const ImportCleanupSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    url: z.string(),
    title: z.string(),
    description: z.string(),
    tags: z.array(z.string()).max(8),
    category: z.string(),
    confidence: z.number().min(0).max(1),
  })).max(25),
});

const AlertDigestSchema = z.object({
  summary: z.string(),
  likelyCause: z.string(),
  action: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  confidence: z.number().min(0).max(1),
});

const ArchiveRescueSuggestionSchema = z.object({
  candidates: z.array(z.object({
    url: z.string(),
    reason: z.string(),
    confidence: z.number().min(0).max(1),
  })).max(8),
  searchQueries: z.array(z.string()).max(5),
});

const bookmarkEnrichmentJsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    summary: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    category: { type: 'string' },
    language: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['title', 'description', 'summary', 'tags', 'category', 'language', 'confidence'],
  additionalProperties: false,
} as const;

const archiveSummaryJsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    category: { type: 'string' },
    language: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['summary', 'tags', 'category', 'language', 'confidence'],
  additionalProperties: false,
} as const;

const importCleanupJsonSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      maxItems: 25,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 8 },
          category: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['id', 'url', 'title', 'description', 'tags', 'category', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

const alertDigestJsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    likelyCause: { type: 'string' },
    action: { type: 'string' },
    severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['summary', 'likelyCause', 'action', 'severity', 'confidence'],
  additionalProperties: false,
} as const;

const archiveRescueJsonSchema = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          reason: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['url', 'reason', 'confidence'],
        additionalProperties: false,
      },
    },
    searchQueries: { type: 'array', items: { type: 'string' }, maxItems: 5 },
  },
  required: ['candidates', 'searchQueries'],
  additionalProperties: false,
} as const;

export function deepInfraConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DeepInfraConfig | null {
  if (env.LLM_ENABLED === '0' || env.LLM_ENABLED === 'false') return null;
  const token = (env.DEEPINFRA_TOKEN ?? env.DEEPINFRA_API_KEY ?? '').trim();
  if (!token) return null;
  const chatModel = env.DEEPINFRA_CHAT_MODEL ?? DEFAULT_CHAT_MODEL;
  const config = {
    token,
    baseUrl: (env.DEEPINFRA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
    nativeBaseUrl: (env.DEEPINFRA_NATIVE_BASE_URL ?? DEFAULT_NATIVE_BASE_URL).replace(/\/$/, ''),
    enrichmentModel: env.DEEPINFRA_ENRICH_MODEL ?? chatModel,
    summaryModel: env.DEEPINFRA_SUMMARY_MODEL ?? chatModel,
    importModel: env.DEEPINFRA_IMPORT_MODEL ?? chatModel,
    alertModel: env.DEEPINFRA_ALERT_MODEL ?? chatModel,
    rescueModel: env.DEEPINFRA_RESCUE_MODEL ?? DEFAULT_RESCUE_MODEL,
    embeddingModel: env.DEEPINFRA_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    rerankModel: env.DEEPINFRA_RERANK_MODEL ?? DEFAULT_RERANK_MODEL,
    timeoutMs: Number.parseInt(env.DEEPINFRA_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10) || DEFAULT_TIMEOUT_MS,
    chatTimeoutMs: Number.parseInt(env.DEEPINFRA_CHAT_TIMEOUT_MS ?? String(DEFAULT_CHAT_TIMEOUT_MS), 10) || DEFAULT_CHAT_TIMEOUT_MS,
    // Use || not ?? — compose passes these as empty strings (`${VAR:-}`) when
    // unset, and "" must fall through to the default (?? only catches null).
    chatFallbackToken: (env.CEREBRAS_TOKEN ?? env.CEREBRAS_API_KEY ?? '').trim() || null,
    chatFallbackBaseUrl: (env.CEREBRAS_BASE_URL || DEFAULT_CHAT_FALLBACK_BASE_URL).replace(/\/$/, ''),
    chatFallbackModel: env.CEREBRAS_CHAT_MODEL || DEFAULT_CHAT_FALLBACK_MODEL,
  };
  validateOpenSourceConfig(config);
  return config;
}

export class DeepInfraClient {
  constructor(private readonly config: DeepInfraConfig | null) {}

  get enabled(): boolean {
    return !!this.config;
  }

  modelSummary(): Record<string, string> | null {
    if (!this.config) return null;
    return {
      enrichment: this.config.enrichmentModel,
      summary: this.config.summaryModel,
      import: this.config.importModel,
      alert: this.config.alertModel,
      rescue: this.config.rescueModel,
      embedding: this.config.embeddingModel,
      rerank: this.config.rerankModel,
      ...(this.config.chatFallbackToken ? { chatFallback: this.config.chatFallbackModel } : {}),
    };
  }

  async enrichBookmark(input: BookmarkEnrichmentInput, opts: { timeoutMs?: number } = {}): Promise<BookmarkEnrichment | null> {
    if (!this.config) return null;
    const parsed = await this.chatJson({
      model: this.config.enrichmentModel,
      name: 'bookmark_enrichment',
      schema: bookmarkEnrichmentJsonSchema,
      zodSchema: BookmarkEnrichmentSchema,
      maxTokens: 500,
      timeoutMs: opts.timeoutMs,
      messages: [
        {
          role: 'system',
          content: [
            'You enrich bookmark metadata for Deepmarks.',
            'Use only the provided URL and metadata; do not invent facts.',
            'Return concise fields suitable for a bookmark card.',
            'Use empty strings when a field cannot be inferred.',
            'Provide 4-8 tags as lowercase short topical tokens (single words or short hyphenated terms), not phrases.',
            'Tags should span several facets: the main subject, the broader field or domain, the key technology or tools the page is built on or about, and the content type (such as app, tool, article, or repo).',
            'When the page is about or built on AI, LLMs, or a programming technology, include the relevant tags (for example ai, llm, programming, coding) alongside the subject tags.',
            'Order tags from most to least central to what the page is.',
          ].join(' '),
        },
        { role: 'user', content: JSON.stringify(input) },
      ],
    });
    return cleanBookmarkEnrichment(parsed);
  }

  async summarizeArchive(input: ArchiveSummaryInput): Promise<ArchiveSummary | null> {
    if (!this.config) return null;
    const parsed = await this.chatJson({
      model: this.config.summaryModel,
      name: 'archive_summary',
      schema: archiveSummaryJsonSchema,
      zodSchema: ArchiveSummarySchema,
      maxTokens: 450,
      messages: [
        {
          role: 'system',
          content: [
            'Summarize an archived bookmark from its known metadata.',
            'Do not claim you read full page text unless it is present.',
            'Use empty strings for unknown fields.',
            'Tags must be lowercase short topical tokens.',
          ].join(' '),
        },
        { role: 'user', content: JSON.stringify(input) },
      ],
    });
    return cleanArchiveSummary(parsed);
  }

  async cleanupImportedBookmarks(items: ImportCleanupItem[]): Promise<ImportCleanupSuggestion[]> {
    if (!this.config || items.length === 0) return [];
    const capped = items.slice(0, 25).map((item, index) => ({
      id: item.id ?? String(index),
      url: item.url,
      title: item.title ?? '',
      description: item.description ?? '',
      tags: item.tags ?? [],
    }));
    const parsed = await this.chatJson({
      model: this.config.importModel,
      name: 'import_cleanup',
      schema: importCleanupJsonSchema,
      zodSchema: ImportCleanupSchema,
      maxTokens: 2_000,
      messages: [
        {
          role: 'system',
          content: [
            'Clean imported bookmark metadata.',
            'Preserve URLs and IDs exactly.',
            'Improve missing or noisy titles/descriptions only when supported by the input.',
            'Return lowercase short tags and remove duplicates.',
          ].join(' '),
        },
        { role: 'user', content: JSON.stringify({ items: capped }) },
      ],
    });
    return parsed.items.map(cleanImportSuggestion).filter((item): item is ImportCleanupSuggestion => !!item);
  }

  async summarizeAlert(input: { subject: string; body: string; severity: string; key: string }): Promise<AlertDigest | null> {
    if (!this.config) return null;
    const parsed = await this.chatJson({
      model: this.config.alertModel,
      name: 'alert_digest',
      schema: alertDigestJsonSchema,
      zodSchema: AlertDigestSchema,
      maxTokens: 400,
      messages: [
        {
          role: 'system',
          content: [
            'Summarize an operational alert for the site operator.',
            'Focus on whether action is needed, likely cause, and next step.',
            'Do not soften critical incidents.',
          ].join(' '),
        },
        { role: 'user', content: JSON.stringify(input) },
      ],
    });
    return {
      summary: cleanText(parsed.summary, 500) ?? '',
      likelyCause: cleanText(parsed.likelyCause, 300),
      action: cleanText(parsed.action, 300),
      severity: parsed.severity,
      confidence: clamp01(parsed.confidence),
    };
  }

  async suggestArchiveRescue(input: ArchiveRescueInput): Promise<ArchiveRescueSuggestion | null> {
    if (!this.config) return null;
    const parsed = await this.chatJson({
      model: this.config.rescueModel,
      name: 'archive_rescue',
      schema: archiveRescueJsonSchema,
      zodSchema: ArchiveRescueSuggestionSchema,
      maxTokens: 1_200,
      messages: [
        {
          role: 'system',
          content: [
            'Suggest public alternative URLs for rescuing a failed web archive.',
            'Do not suggest bypassing login, CAPTCHA, paywalls, robots, or access controls.',
            'Prefer public mirrors, known domain migrations, canonical public share URLs,',
            'print/AMP/public RSS copies, or existing archive URLs.',
            'Only return candidate URLs when the URL is plausible from known web patterns.',
            'If uncertain, return search query strings rather than made-up URLs.',
          ].join(' '),
        },
        { role: 'user', content: JSON.stringify(input) },
      ],
    });
    return {
      candidates: parsed.candidates.map(cleanArchiveRescueCandidate).filter((item): item is ArchiveRescueSuggestion['candidates'][number] => !!item),
      searchQueries: parsed.searchQueries
        .map((query) => cleanText(query, 200))
        .filter((query): query is string => !!query)
        .slice(0, 5),
    };
  }

  async embedText(input: string): Promise<number[] | null> {
    if (!this.config) return null;
    const text = cleanText(input, 16_000);
    if (!text) return null;
    const body = {
      model: this.config.embeddingModel,
      input: text,
      encoding_format: 'float',
    };
    const raw = await this.fetchJson<{ data?: Array<{ embedding?: unknown }> }>(
      `${this.config.baseUrl}/embeddings`,
      body,
    );
    const embedding = raw.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) return null;
    const vector = embedding
      .map((n) => typeof n === 'number' && Number.isFinite(n) ? n : null)
      .filter((n): n is number => n !== null);
    return vector.length > 0 ? vector : null;
  }

  async rerank(query: string, documents: string[]): Promise<number[] | null> {
    if (!this.config || documents.length === 0) return null;
    const raw = await this.fetchJson<{ scores?: unknown }>(
      `${this.config.nativeBaseUrl}/${this.config.rerankModel}`,
      {
        query: cleanText(query, 2_000) ?? query.slice(0, 2_000),
        documents: documents.slice(0, 100).map((doc) => cleanText(doc, 4_000) ?? ''),
      },
    );
    if (!Array.isArray(raw.scores)) return null;
    return raw.scores.map((n) => typeof n === 'number' && Number.isFinite(n) ? n : 0);
  }

  private async chatJson<T>(opts: {
    model: string;
    name: string;
    schema: Record<string, unknown>;
    zodSchema: z.ZodType<T>;
    messages: Array<{ role: 'system' | 'user'; content: string }>;
    maxTokens: number;
    timeoutMs?: number;
  }): Promise<T> {
    if (!this.config) throw new Error('DeepInfra client is disabled');
    const timeoutMs = opts.timeoutMs ?? this.config.chatTimeoutMs;
    try {
      // Primary: DeepInfra (open-source; the per-role model in opts.model).
      return await this.chatCompletionOnce<T>(opts, {
        baseUrl: this.config.baseUrl,
        token: this.config.token,
        model: opts.model,
        timeoutMs,
      });
    } catch (primaryErr) {
      // DeepInfra timed out / errored — fail over to the fast chat fallback
      // (Cerebras gpt-oss-120b) when configured, so a spike or incident makes
      // the call slower-but-successful instead of a dropped job.
      const fallbackToken = this.config.chatFallbackToken;
      const fallbackBaseUrl = this.config.chatFallbackBaseUrl;
      if (!fallbackToken || !fallbackBaseUrl) throw primaryErr;
      try {
        return await this.chatCompletionOnce<T>(opts, {
          baseUrl: fallbackBaseUrl,
          token: fallbackToken,
          model: this.config.chatFallbackModel,
          timeoutMs,
          reasoningEffort: 'low',
        });
      } catch {
        // Surface the primary error — it's the meaningful one to debug.
        throw primaryErr;
      }
    }
  }

  private async chatCompletionOnce<T>(
    opts: {
      name: string;
      schema: Record<string, unknown>;
      zodSchema: z.ZodType<T>;
      messages: Array<{ role: 'system' | 'user'; content: string }>;
      maxTokens: number;
    },
    provider: { baseUrl: string; token: string; model: string; timeoutMs: number; reasoningEffort?: 'low' | 'medium' | 'high' },
  ): Promise<T> {
    const body: Record<string, unknown> = {
      model: provider.model,
      messages: opts.messages,
      temperature: 0.2,
      // Reasoning models (the fallback) spend tokens thinking before the answer;
      // give a little headroom so the JSON body isn't truncated.
      max_tokens: provider.reasoningEffort ? opts.maxTokens + 512 : opts.maxTokens,
      response_format: {
        type: 'json_schema',
        json_schema: { name: opts.name, strict: true, schema: opts.schema },
      },
    };
    if (provider.reasoningEffort) body.reasoning_effort = provider.reasoningEffort;
    const raw = await this.fetchJson<{
      choices?: Array<{ message?: { content?: string | null } }>;
    }>(`${provider.baseUrl}/chat/completions`, body, { token: provider.token, timeoutMs: provider.timeoutMs });
    const content = raw.choices?.[0]?.message?.content;
    if (!content) throw new Error('chat completion returned no content');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`chat completion returned invalid JSON: ${(err as Error).message}`);
    }
    return opts.zodSchema.parse(parsed);
  }

  private async fetchJson<T>(url: string, body: unknown, opts: { token?: string; timeoutMs?: number } = {}): Promise<T> {
    if (!this.config) throw new Error('DeepInfra client is disabled');
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(opts.timeoutMs ?? this.config.timeoutMs),
      headers: {
        'Authorization': `Bearer ${opts.token ?? this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }
}

function validateOpenSourceConfig(config: DeepInfraConfig): void {
  validateOpenSourceModel('enrichment', config.enrichmentModel, OPEN_SOURCE_CHAT_MODELS);
  validateOpenSourceModel('summary', config.summaryModel, OPEN_SOURCE_CHAT_MODELS);
  validateOpenSourceModel('import', config.importModel, OPEN_SOURCE_CHAT_MODELS);
  validateOpenSourceModel('alert', config.alertModel, OPEN_SOURCE_CHAT_MODELS);
  validateOpenSourceModel('rescue', config.rescueModel, OPEN_SOURCE_CHAT_MODELS);
  validateOpenSourceModel('embedding', config.embeddingModel, OPEN_SOURCE_EMBEDDING_MODELS);
  validateOpenSourceModel('rerank', config.rerankModel, OPEN_SOURCE_RERANK_MODELS);
  if (config.chatFallbackToken) {
    validateOpenSourceModel('chat-fallback', config.chatFallbackModel, OPEN_SOURCE_CHAT_MODELS);
  }
}

function validateOpenSourceModel(role: string, model: string, approved: Set<string>): void {
  if (!approved.has(model)) throw new DeepInfraModelPolicyError(role, model);
}

function cleanBookmarkEnrichment(raw: z.infer<typeof BookmarkEnrichmentSchema>): BookmarkEnrichment {
  return {
    title: cleanText(raw.title, 180),
    description: cleanText(raw.description, 320),
    summary: cleanText(raw.summary, 500),
    tags: cleanTags(raw.tags),
    category: cleanText(raw.category, 60),
    language: cleanText(raw.language, 40),
    confidence: clamp01(raw.confidence),
  };
}

function cleanArchiveSummary(raw: z.infer<typeof ArchiveSummarySchema>): ArchiveSummary {
  return {
    summary: cleanText(raw.summary, 700),
    tags: cleanTags(raw.tags),
    category: cleanText(raw.category, 60),
    language: cleanText(raw.language, 40),
    confidence: clamp01(raw.confidence),
  };
}

function cleanImportSuggestion(raw: z.infer<typeof ImportCleanupSchema>['items'][number]): ImportCleanupSuggestion | null {
  const url = cleanText(raw.url, 2_000);
  if (!url) return null;
  return {
    id: cleanText(raw.id, 120),
    url,
    title: cleanText(raw.title, 180),
    description: cleanText(raw.description, 320),
    tags: cleanTags(raw.tags),
    category: cleanText(raw.category, 60),
    confidence: clamp01(raw.confidence),
  };
}

function cleanArchiveRescueCandidate(
  raw: z.infer<typeof ArchiveRescueSuggestionSchema>['candidates'][number],
): ArchiveRescueSuggestion['candidates'][number] | null {
  const url = cleanText(raw.url, 2_000);
  if (!url) return null;
  return {
    url,
    reason: cleanText(raw.reason, 240) ?? '',
    confidence: clamp01(raw.confidence),
  };
}

function cleanTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    for (const part of raw.split(/[,\s#]+/)) {
      const tag = normalizeTag(part);
      if (tag && !out.includes(tag)) out.push(tag);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function cleanText(value: string | undefined, max: number): string | undefined {
  const text = value
    ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max).trim() : text;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
