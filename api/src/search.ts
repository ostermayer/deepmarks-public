import { SimplePool, type Event as NostrEvent } from 'nostr-tools';
import { bookmarkEventToJson } from './api-helpers.js';
import { normalizeNaturalSearchQuery } from './natural-query.js';

/**
 * Public bookmark search indexer.
 *
 * Subscribes to our relay for kind:39701 events, transforms them into
 * Meilisearch documents, and upserts on a debounced batch. Also listens
 * for kind:9735 zap receipts to keep the zap_total field fresh.
 *
 * Delisted-event and URL-blocklist filtering happens at query time,
 * not at index time — that way lift/restore is instant without
 * reindexing.
 */

const INDEX_NAME = 'bookmarks';
const BATCH_INTERVAL_MS = 2_000;
const BATCH_MAX_SIZE = 100;

export interface BookmarkDoc {
  /** Nostr event ID (hex) — the Meilisearch primary key */
  id: string;
  url: string;
  title: string;
  description: string;
  tags: string[];
  author_pubkey: string;
  author_name?: string;
  domain: string;
  filetype?: string;
  has_pdf: boolean;
  is_scholarly: boolean;
  /** Bookmark save time in unix seconds. Kept as `created_at` for
   *  backwards compatibility with the existing Meilisearch schema and
   *  API response. */
  created_at: number;
  saved_at_ms?: number;
  /** Cumulative sats zapped at this bookmark event. Updated by zap-receipt listener. */
  zap_total: number;
  /** Number of distinct pubkeys that have bookmarked the same URL. */
  save_count: number;
  /** LLM-generated fields are additive: user-authored metadata stays untouched. */
  llm_summary?: string;
  llm_tags?: string[];
  llm_category?: string;
  llm_language?: string;
  llm_confidence?: number;
}

export interface SearchQuery {
  q?: string;
  tags?: string[];
  author?: string;
  site?: string;
  filetype?: string;
  hasPdf?: boolean;
  scholarly?: boolean;
  after?: number;   // unix seconds
  before?: number;
  minZaps?: number;
  minSaves?: number;
  limit?: number;
  offset?: number;
  delistedEventIds?: Set<string>;
}

export interface SearchResult {
  hits: Array<{
    event_id: string;
    score: number;
    highlights: Record<string, string>;
    doc: BookmarkDoc;
  }>;
  total: number;
  query_time_ms: number;
}

/**
 * Minimal Meilisearch HTTP client — we use three endpoints (index config,
 * documents add, search), and a full-fat SDK is unnecessary overhead.
 */
export class MeilisearchClient {
  constructor(
    private readonly baseUrl: string,
    private readonly masterKey: string,
  ) {}

  async ensureIndex(): Promise<void> {
    // Create index if missing. Idempotent.
    await this.req('POST', '/indexes', {
      uid: INDEX_NAME,
      primaryKey: 'id',
    }).catch((err) => {
      if (!String(err).includes('index_already_exists')) throw err;
    });

    // Configure searchable attributes (order matters — earlier = higher weight).
    await this.req('PUT', `/indexes/${INDEX_NAME}/settings/searchable-attributes`, [
      'title',
      'description',
      'tags',
      'llm_summary',
      'llm_tags',
      'llm_category',
      'url',
      'author_name',
    ]);

    await this.req('PUT', `/indexes/${INDEX_NAME}/settings/filterable-attributes`, [
      'tags',
      'author_pubkey',
      'domain',
      'filetype',
      'has_pdf',
      'is_scholarly',
      'llm_category',
      'llm_language',
      'created_at',
      'zap_total',
      'save_count',
    ]);

    await this.req('PUT', `/indexes/${INDEX_NAME}/settings/sortable-attributes`, [
      'created_at',
      'zap_total',
      'save_count',
    ]);

    // Custom ranking rules: relevance first, then our weighted scoring.
    // Meilisearch supports expression-based ranking via `words`, `typo`,
    // `proximity`, `attribute`, then custom `desc(field)` rules.
    await this.req('PUT', `/indexes/${INDEX_NAME}/settings/ranking-rules`, [
      'words',
      'typo',
      'proximity',
      'attribute',
      'zap_total:desc',
      'save_count:desc',
      'created_at:desc',
    ]);
  }

  /** GET /health — used by the operator dashboard. Never throws. */
  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      if (!res.ok) return false;
      const body = (await res.json()) as { status?: string };
      return body.status === 'available';
    } catch {
      return false;
    }
  }

  async upsertBatch(docs: BookmarkDoc[]): Promise<void> {
    if (docs.length === 0) return;
    await this.req('POST', `/indexes/${INDEX_NAME}/documents`, docs);
  }

  /** Partial-document update — Meili's PUT /documents is add-or-UPDATE
   *  (merges fields into the existing doc). upsertBatch's POST is
   *  add-or-REPLACE: flushing an {id, save_count} stub through it wiped
   *  every other field of the indexed bookmark until the next indexer
   *  replay (2026-08-23 review #2). Counter flushes must use this. */
  async updateBatch(docs: Array<Partial<BookmarkDoc> & { id: string }>): Promise<void> {
    if (docs.length === 0) return;
    await this.req('PUT', `/indexes/${INDEX_NAME}/documents`, docs);
  }

  async documents(opts: { limit?: number; offset?: number } = {}): Promise<{
    results: BookmarkDoc[];
    limit: number;
    offset: number;
    total: number | null;
  }> {
    const params = new URLSearchParams();
    params.set('limit', String(opts.limit ?? 100));
    params.set('offset', String(opts.offset ?? 0));
    const response = await this.req<{
      results?: unknown[];
      limit?: number;
      offset?: number;
      total?: number;
    }>('GET', `/indexes/${INDEX_NAME}/documents?${params.toString()}`);
    const results = Array.isArray(response.results)
      ? response.results.filter(isBookmarkDoc)
      : [];
    return {
      results,
      limit: response.limit ?? opts.limit ?? 100,
      offset: response.offset ?? opts.offset ?? 0,
      total: typeof response.total === 'number' ? response.total : null,
    };
  }

  async delete(id: string): Promise<void> {
    await this.req('DELETE', `/indexes/${INDEX_NAME}/documents/${id}`);
  }

  async search(query: SearchQuery & { sort?: string[] }): Promise<SearchResult> {
    const filters: string[] = [];
    if (query.tags && query.tags.length) {
      filters.push('(' + query.tags.map((t) => `tags = "${escape(t)}"`).join(' AND ') + ')');
    }
    if (query.author) filters.push(`author_pubkey = "${escape(query.author)}"`);
    if (query.site) filters.push(`domain = "${escape(query.site)}"`);
    if (query.filetype) filters.push(`filetype = "${escape(query.filetype)}"`);
    if (query.hasPdf) filters.push('has_pdf = true');
    if (query.scholarly) filters.push('is_scholarly = true');
    if (query.after) filters.push(`created_at >= ${query.after}`);
    if (query.before) filters.push(`created_at <= ${query.before}`);
    if (query.minZaps) filters.push(`zap_total >= ${query.minZaps}`);
    if (query.minSaves) filters.push(`save_count >= ${query.minSaves}`);

    // Delisted events excluded by id list. Meilisearch has a reasonable
    // filter-size limit (~1000 terms); above that we'd need a separate
    // post-filter pass, but at MVP scale the delisted set is small.
    if (query.delistedEventIds && query.delistedEventIds.size > 0) {
      const ids = [...query.delistedEventIds].map((id) => `"${escape(id)}"`).join(', ');
      filters.push(`NOT id IN [${ids}]`);
    }

    const body: Record<string, unknown> = {
      q: query.q ?? '',
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
      attributesToHighlight: ['title', 'description'],
      highlightPreTag: '<mark>',
      highlightPostTag: '</mark>',
    };
    if (filters.length) body.filter = filters.join(' AND ');
    // Optional sort — used by the RSS feed builders to get a strict
    // recency or popularity ordering instead of relevance scoring.
    if (query.sort && query.sort.length) body.sort = query.sort;

    const response = await this.req<MeiliSearchResponse>(
      'POST',
      `/indexes/${INDEX_NAME}/search`,
      body,
    );

    return {
      hits: response.hits.map((h) => ({
        event_id: h.id,
        score: h._rankingScore ?? 0,
        highlights: h._formatted ?? {},
        doc: h as unknown as BookmarkDoc,
      })),
      total: response.estimatedTotalHits ?? response.hits.length,
      query_time_ms: response.processingTimeMs,
    };
  }

  private async req<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.masterKey}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`meili ${method} ${path} ${res.status}: ${errBody}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }
}

interface MeiliSearchResponse {
  hits: Array<Record<string, unknown> & { id: string; _rankingScore?: number; _formatted?: Record<string, string> }>;
  estimatedTotalHits?: number;
  processingTimeMs: number;
}

function escape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

function isBookmarkDoc(value: unknown): value is BookmarkDoc {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  return (
    typeof doc.id === 'string' &&
    typeof doc.url === 'string' &&
    typeof doc.title === 'string' &&
    typeof doc.description === 'string' &&
    Array.isArray(doc.tags) &&
    typeof doc.author_pubkey === 'string' &&
    typeof doc.domain === 'string' &&
    typeof doc.created_at === 'number'
  );
}

/**
 * Indexer worker — subscribes to our relay for kind:39701 events and
 * upserts to Meilisearch. Debounced batching keeps Meili happy under
 * high event rates (e.g. during a mass-import from a Pinboard export).
 */
export class BookmarkIndexer {
  private buffer: BookmarkDoc[] = [];
  private flushTimer?: NodeJS.Timeout;
  private pool?: SimplePool;
  private sub?: { close: () => void };

  constructor(
    private readonly meili: MeilisearchClient,
    private readonly relayUrl: string,
    private readonly logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
    private readonly profileResolver: (pubkey: string) => Promise<string | undefined>,
    private readonly saveCountResolver: (url: string) => Promise<number>,
    private readonly onEvent?: (event: NostrEvent) => Promise<void>,
    private readonly onDoc?: (doc: BookmarkDoc) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    await this.meili.ensureIndex();
    this.pool = new SimplePool();
    this.logger.info(`indexer connecting to ${this.relayUrl}`);

    // Subscribe from "now minus 1 day" to catch any events we missed
    // during restart. Persist checkpoint to Redis for production use.
    const since = Math.floor(Date.now() / 1000) - 86_400;
    this.sub = this.pool.subscribeMany(
      [this.relayUrl],
      { kinds: [39701], since },
      {
        onevent: (event) => this.handleEvent(event).catch((err) => {
          this.logger.error('indexer event error:', err);
        }),
      },
    );
  }

  async stop(): Promise<void> {
    this.sub?.close();
    await this.flush();
    this.pool?.close([this.relayUrl]);
  }

  private async handleEvent(event: NostrEvent): Promise<void> {
    if (this.onEvent) {
      await this.onEvent(event).catch((err) => {
        this.logger.error('indexer side-cache failed:', err);
      });
    }
    const doc = await this.eventToDoc(event);
    if (!doc) return;
    this.buffer.push(doc);
    this.scheduleFlush();
    if (this.onDoc) {
      this.onDoc(doc).catch((err) => {
        this.logger.error('indexer doc side-effect failed:', err);
      });
    }
    if (this.buffer.length >= BATCH_MAX_SIZE) await this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush().catch(() => {}), BATCH_INTERVAL_MS);
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    try {
      await this.meili.upsertBatch(batch);
      this.logger.info(`indexed ${batch.length} bookmarks`);
    } catch (err) {
      this.logger.error('indexer flush failed — re-queueing:', err);
      this.buffer.unshift(...batch);
    }
  }

  private async eventToDoc(event: NostrEvent): Promise<BookmarkDoc | null> {
    const bookmark = bookmarkEventToJson(event);
    const url = bookmark.url;
    if (!url) return null;
    // http(s) only — the two sibling ingest paths already reject
    // javascript:/data: d-tags; without this a kind:39701 published
    // straight to strfry surfaced as a clickable javascript: link in
    // /search/public (2026-08-23 review #15, stored XSS).
    try {
      const p = new URL(url).protocol;
      if (p !== 'http:' && p !== 'https:') return null;
    } catch {
      return null;
    }

    let domain: string;
    try {
      domain = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      domain = 'unknown';
    }

    // Resolve these lazily; profileResolver should be cached, and
    // save_count comes from a pre-computed relay-side view. Failing
    // either just gives a less-rich doc — don't fail the whole insert.
    const author_name = await this.profileResolver(event.pubkey).catch(() => undefined);
    const save_count = await this.saveCountResolver(url).catch(() => 0);

    return {
      id: event.id,
      url,
      title: bookmark.title,
      description: bookmark.description,
      tags: bookmark.tags,
      author_pubkey: event.pubkey,
      author_name,
      domain,
      filetype: bookmarkFiletype(url),
      has_pdf: bookmarkHasPdf(url),
      is_scholarly: isScholarlyBookmark({
        url,
        title: bookmark.title,
        description: bookmark.description,
        tags: bookmark.tags,
      }),
      created_at: bookmark.savedAt,
      saved_at_ms: bookmark.savedAtMs,
      zap_total: 0,   // updated separately by zap-receipt listener
      save_count,
    };
  }
}

/**
 * Parse a Pinboard-style query string into SearchQuery fields.
 * Called from the /search/public route handler.
 *
 * Examples:
 *   "rust async"              → { q: "rust async" }
 *   "#rust async"             → { q: "async", tags: ["rust"] }
 *   "by:fiatjaf rust"         → { q: "rust", author: "<resolved>" }
 *   "site:paulgraham.com"     → { site: "paulgraham.com" }
 *   "zaps:>100 #rust"         → { minZaps: 100, tags: ["rust"] }
 *   "after:2025-01"           → { after: <unix-seconds-for-2025-01-01> }
 */
export function parseQuery(raw: string, tagNormalizer: (t: string) => string): SearchQuery {
  const out: SearchQuery = {};
  const plain: string[] = [];
  const normalized = normalizeNaturalSearchQuery(raw);

  for (const token of normalized.query.split(/\s+/).filter(Boolean)) {
    // Hashtag: #rust
    if (token.startsWith('#')) {
      (out.tags ??= []).push(tagNormalizer(token.slice(1)));
      continue;
    }
    // tag:rust
    const tagMatch = /^tag:(.+)$/i.exec(token);
    if (tagMatch) {
      (out.tags ??= []).push(tagNormalizer(tagMatch[1]));
      continue;
    }
    // @author or by:author
    const authorMatch = /^(?:@|by:)(.+)$/i.exec(token);
    if (authorMatch) {
      // Caller is expected to resolve username → pubkey before hitting Meili.
      out.author = authorMatch[1];
      continue;
    }
    // site:domain
    const siteMatch = /^site:(.+)$/i.exec(token);
    if (siteMatch) {
      out.site = siteMatch[1].toLowerCase();
      continue;
    }
    // filetype:pdf / type:pdf
    const filetypeMatch = /^(?:filetype|type):(.+)$/i.exec(token);
    if (filetypeMatch) {
      out.filetype = filetypeMatch[1].toLowerCase().replace(/^\./, '');
      continue;
    }
    if (/^has:pdf$/i.test(token)) {
      out.hasPdf = true;
      continue;
    }
    if (/^scholarly:(?:1|true|yes)$/i.test(token)) {
      out.scholarly = true;
      continue;
    }
    // zaps:>N
    const zapsMatch = /^zaps:>(\d+)$/i.exec(token);
    if (zapsMatch) {
      out.minZaps = parseInt(zapsMatch[1], 10);
      continue;
    }
    // saves:>N
    const savesMatch = /^saves:>(\d+)$/i.exec(token);
    if (savesMatch) {
      out.minSaves = parseInt(savesMatch[1], 10);
      continue;
    }
    // after:YYYY-MM[-DD] or before:
    const dateMatch = /^(after|before):(.+)$/i.exec(token);
    if (dateMatch) {
      const parsed = parseRelativeDate(dateMatch[2]);
      if (parsed !== null) {
        if (dateMatch[1].toLowerCase() === 'after') out.after = parsed;
        else out.before = parsed;
        continue;
      }
    }
    plain.push(token);
  }

  if (plain.length) out.q = plain.join(' ');
  return out;
}

function parseRelativeDate(s: string): number | null {
  const now = Math.floor(Date.now() / 1000);
  const day = 86_400;
  switch (s.toLowerCase()) {
    case 'today': return now - day;
    case 'yesterday': return now - 2 * day;
    case 'last-week': return now - 7 * day;
    case 'last-month': return now - 30 * day;
    case 'last-year': return now - 365 * day;
  }
  const absolute = Date.parse(s);
  if (!isNaN(absolute)) return Math.floor(absolute / 1000);
  return null;
}

export function bookmarkFiletype(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (/\/pdf(?:\/|$)/.test(pathname)) return 'pdf';
    const match = /\.([a-z0-9]{2,8})(?:$|[?#/])/.exec(pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function bookmarkHasPdf(url: string): boolean {
  if (bookmarkFiletype(url) === 'pdf') return true;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.toLowerCase();
    if (host === 'arxiv.org' && /^\/abs\//.test(path)) return true;
    if (host === 'pmc.ncbi.nlm.nih.gov' && /^\/articles\/pmc\d+\/?$/.test(path)) return true;
    if ((host === 'biorxiv.org' || host === 'medrxiv.org') && /\/content\//.test(path)) return true;
  } catch {
    return false;
  }
  return false;
}

const SCHOLARLY_DOMAINS = [
  'academia.edu',
  'arxiv.org',
  'biorxiv.org',
  'cambridge.org',
  'cell.com',
  'doi.org',
  'frontiersin.org',
  'jamanetwork.com',
  'jbc.org',
  'medrxiv.org',
  'nature.com',
  'nejm.org',
  'nih.gov',
  'osf.io',
  'plos.org',
  'pubmed.ncbi.nlm.nih.gov',
  'researchgate.net',
  'sciencedirect.com',
  'science.org',
  'springer.com',
  'tandfonline.com',
  'wiley.com',
];

export function isScholarlyBookmark(bookmark: Pick<BookmarkDoc, 'url' | 'title' | 'description' | 'tags'>): boolean {
  let host = '';
  try {
    host = new URL(bookmark.url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    host = '';
  }
  if (host.endsWith('.edu') || SCHOLARLY_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return true;
  }
  const text = `${bookmark.title}\n${bookmark.description}\n${bookmark.tags.join(' ')}`.toLowerCase();
  return /\b(?:abstract|academic|arxiv|doi|journal|meta-analysis|paper|preprint|pubmed|randomi[sz]ed|research|review|scholarly|study|trial)\b/.test(text);
}
