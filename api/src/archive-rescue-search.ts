export type ArchiveRescueSearchProvider = 'none' | 'searxng' | 'brave';

export interface ArchiveRescueSearchConfig {
  provider: ArchiveRescueSearchProvider;
  url: string;
  token?: string;
  timeoutMs: number;
  maxResults: number;
  /** With a Brave key present alongside the searxng provider, empty/failed
   *  searxng responses fall through to the authenticated Brave API — the
   *  public engines captcha datacenter IPs under load, the paid API never
   *  does. Undefined = no fallback. */
  braveFallback?: { url: string; token: string };
}

export interface ArchiveRescueSearchResult {
  url: string;
  title?: string;
  snippet?: string;
  source?: string;
}

const DEFAULT_SEARXNG_URL = 'http://searxng:8080/search';
const DEFAULT_BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_MAX_RESULTS = 10;

export function archiveRescueSearchConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ArchiveRescueSearchConfig | null {
  const rawProvider = (env.ARCHIVE_RESCUE_SEARCH_PROVIDER ?? '').trim().toLowerCase();
  const provider = normalizeProvider(rawProvider || defaultProvider(env));
  if (provider === 'none') return null;

  const timeoutMs = envInt(env.ARCHIVE_RESCUE_SEARCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxResults = envInt(env.ARCHIVE_RESCUE_SEARCH_MAX_RESULTS, DEFAULT_MAX_RESULTS);
  const braveToken = (env.BRAVE_SEARCH_API_KEY ?? env.ARCHIVE_RESCUE_SEARCH_TOKEN ?? '').trim();
  // The Brave endpoint is deliberately NOT read from ARCHIVE_RESCUE_SEARCH_URL:
  // compose always sets that var (defaulted to the searxng URL), which must
  // never be used as the Brave API endpoint.
  const braveUrl = (env.BRAVE_SEARCH_API_URL ?? DEFAULT_BRAVE_URL).trim();

  if (provider === 'brave') {
    if (!braveToken) return null;
    return { provider, url: braveUrl, token: braveToken, timeoutMs, maxResults };
  }

  return {
    provider,
    url: (env.ARCHIVE_RESCUE_SEARCH_URL ?? DEFAULT_SEARXNG_URL).trim(),
    timeoutMs,
    maxResults,
    braveFallback: braveToken ? { url: braveUrl, token: braveToken } : undefined,
  };
}

export class ArchiveRescueSearchClient {
  constructor(private readonly config: ArchiveRescueSearchConfig | null) {}

  get enabled(): boolean {
    return !!this.config;
  }

  summary(): Record<string, string | number | boolean> | null {
    if (!this.config) return null;
    return {
      enabled: true,
      provider: this.config.provider,
      url: this.config.url,
      maxResults: this.config.maxResults,
      timeoutMs: this.config.timeoutMs,
      braveFallback: !!this.config.braveFallback,
    };
  }

  async search(query: string, fetchImpl: typeof fetch = fetch): Promise<ArchiveRescueSearchResult[]> {
    if (!this.config) return [];
    const q = query.trim();
    if (!q) return [];
    if (this.config.provider === 'brave') {
      return searchBrave(this.config.url, this.config.token ?? '', this.config, q, fetchImpl);
    }
    if (this.config.provider !== 'searxng') return [];

    let results: ArchiveRescueSearchResult[] = [];
    let primaryError: unknown = null;
    try {
      results = await searchSearxng(this.config, q, fetchImpl);
    } catch (err) {
      primaryError = err;
    }
    if (results.length > 0) return results;

    // searxng blind (all engines captcha-suspended) or down — fall through
    // to the authenticated Brave API when a key is configured.
    const fallback = this.config.braveFallback;
    if (fallback) {
      try {
        return await searchBrave(fallback.url, fallback.token, this.config, q, fetchImpl);
      } catch {
        // fall through to the primary outcome below
      }
    }
    if (primaryError) throw primaryError;
    return results;
  }
}

async function searchSearxng(
  config: ArchiveRescueSearchConfig,
  query: string,
  fetchImpl: typeof fetch,
): Promise<ArchiveRescueSearchResult[]> {
  const url = new URL(config.url);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('safesearch', '0');
  url.searchParams.set('language', 'auto');
  url.searchParams.set('categories', 'general');
  const res = await fetchImpl(url.toString(), {
    signal: AbortSignal.timeout(config.timeoutMs),
    headers: {
      accept: 'application/json',
      'user-agent': 'Deepmarks-Archive-Rescue/1.0 (+https://deepmarks.org/bot)',
    },
  });
  if (!res.ok) throw new Error(`SearXNG search failed: ${res.status}`);
  const data = await res.json() as {
    results?: Array<{
      url?: unknown;
      title?: unknown;
      content?: unknown;
      engine?: unknown;
      engines?: unknown;
    }>;
  };
  const out: ArchiveRescueSearchResult[] = [];
  for (const item of data.results ?? []) {
    const url = stringValue(item.url);
    if (!url) continue;
    out.push({
      url,
      title: stringValue(item.title),
      snippet: stringValue(item.content),
      source: stringValue(item.engine) ?? stringValue(item.engines),
    });
    if (out.length >= config.maxResults) break;
  }
  return out;
}

async function searchBrave(
  endpoint: string,
  token: string,
  opts: Pick<ArchiveRescueSearchConfig, 'timeoutMs' | 'maxResults'>,
  query: string,
  fetchImpl: typeof fetch,
): Promise<ArchiveRescueSearchResult[]> {
  const url = new URL(endpoint);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(opts.maxResults, 20)));
  url.searchParams.set('safesearch', 'off');
  url.searchParams.set('text_decorations', 'false');
  url.searchParams.set('extra_snippets', 'true');
  const res = await fetchImpl(url.toString(), {
    signal: AbortSignal.timeout(opts.timeoutMs),
    headers: {
      accept: 'application/json',
      'X-Subscription-Token': token,
    },
  });
  if (!res.ok) throw new Error(`Brave search failed: ${res.status}`);
  const data = await res.json() as {
    web?: {
      results?: Array<{
        url?: unknown;
        title?: unknown;
        description?: unknown;
        extra_snippets?: unknown;
      }>;
    };
  };
  const out: ArchiveRescueSearchResult[] = [];
  for (const item of data.web?.results ?? []) {
    const url = stringValue(item.url);
    if (!url) continue;
    out.push({
      url,
      title: stringValue(item.title),
      snippet: [
        stringValue(item.description),
        ...(Array.isArray(item.extra_snippets) ? item.extra_snippets.map(stringValue) : []),
      ].filter(Boolean).join(' '),
      source: 'brave',
    });
    if (out.length >= opts.maxResults) break;
  }
  return out;
}

function defaultProvider(env: NodeJS.ProcessEnv): string {
  if (env.ARCHIVE_RESCUE_SEARCH_URL) return 'searxng';
  if (env.BRAVE_SEARCH_API_KEY || env.ARCHIVE_RESCUE_SEARCH_TOKEN) return 'brave';
  return 'none';
}

function normalizeProvider(value: string): ArchiveRescueSearchProvider {
  if (value === 'searxng' || value === 'brave') return value;
  return 'none';
}

function envInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
