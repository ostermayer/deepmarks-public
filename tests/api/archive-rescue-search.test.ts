import { describe, expect, it, vi } from 'vitest';

import {
  ArchiveRescueSearchClient,
  archiveRescueSearchConfigFromEnv,
} from '@src/archive-rescue-search.js';

describe('archive rescue search client', () => {
  it('uses SearXNG when configured with an internal search URL', () => {
    const config = archiveRescueSearchConfigFromEnv({
      ARCHIVE_RESCUE_SEARCH_URL: 'http://searxng:8080/search',
    });

    expect(config).toMatchObject({
      provider: 'searxng',
      url: 'http://searxng:8080/search',
    });
  });

  it('returns null for Brave without an API token', () => {
    expect(archiveRescueSearchConfigFromEnv({
      ARCHIVE_RESCUE_SEARCH_PROVIDER: 'brave',
    })).toBeNull();
  });

  it('parses SearXNG JSON results', async () => {
    const client = new ArchiveRescueSearchClient({
      provider: 'searxng',
      url: 'http://searxng:8080/search',
      timeoutMs: 1_000,
      maxResults: 2,
    });
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('format=json');
      return new Response(JSON.stringify({
        results: [
          { url: 'https://web.archive.org/web/1/https://example.com', title: 'Archive', content: 'snapshot' },
          { url: 'https://example.com/post', title: 'Original', content: 'page' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await expect(client.search('example', fetchMock as unknown as typeof fetch)).resolves.toEqual([
      { url: 'https://web.archive.org/web/1/https://example.com', title: 'Archive', snippet: 'snapshot', source: undefined },
      { url: 'https://example.com/post', title: 'Original', snippet: 'page', source: undefined },
    ]);
  });

  it('parses Brave web results and sends the subscription token', async () => {
    const client = new ArchiveRescueSearchClient({
      provider: 'brave',
      url: 'https://api.search.brave.com/res/v1/web/search',
      token: 'token',
      timeoutMs: 1_000,
      maxResults: 1,
    });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)['X-Subscription-Token']).toBe('token');
      return new Response(JSON.stringify({
        web: {
          results: [
            { url: 'https://archive.today/example', title: 'Archive Today', description: 'copy', extra_snippets: ['more'] },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await expect(client.search('example', fetchMock as unknown as typeof fetch)).resolves.toEqual([
      { url: 'https://archive.today/example', title: 'Archive Today', snippet: 'copy more', source: 'brave' },
    ]);
  });

  it('configures a Brave fallback for the searxng provider when a key is present', () => {
    const config = archiveRescueSearchConfigFromEnv({
      ARCHIVE_RESCUE_SEARCH_PROVIDER: 'searxng',
      ARCHIVE_RESCUE_SEARCH_URL: 'http://searxng:8080/search',
      BRAVE_SEARCH_API_KEY: 'brave-key',
    } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({
      provider: 'searxng',
      url: 'http://searxng:8080/search',
      braveFallback: { url: 'https://api.search.brave.com/res/v1/web/search', token: 'brave-key' },
    });
  });

  it('never uses the searxng URL as the Brave endpoint', () => {
    // Compose always sets ARCHIVE_RESCUE_SEARCH_URL (defaulted to the searxng
    // URL) — the Brave provider must not inherit it as its API endpoint.
    const config = archiveRescueSearchConfigFromEnv({
      ARCHIVE_RESCUE_SEARCH_PROVIDER: 'brave',
      ARCHIVE_RESCUE_SEARCH_URL: 'http://searxng:8080/search',
      BRAVE_SEARCH_API_KEY: 'brave-key',
    } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({
      provider: 'brave',
      url: 'https://api.search.brave.com/res/v1/web/search',
      token: 'brave-key',
    });
  });

  it('falls back to Brave when searxng returns zero results (engines captcha-suspended)', async () => {
    const client = new ArchiveRescueSearchClient({
      provider: 'searxng',
      url: 'http://searxng:8080/search',
      timeoutMs: 1_000,
      maxResults: 5,
      braveFallback: { url: 'https://api.search.brave.com/res/v1/web/search', token: 'brave-key' },
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('http://searxng:8080/')) {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        web: { results: [{ url: 'https://example.com/a', title: 'From Brave' }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await expect(client.search('query', fetchMock as unknown as typeof fetch)).resolves.toMatchObject([
      { url: 'https://example.com/a', title: 'From Brave', source: 'brave' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not consult Brave when searxng has results', async () => {
    const client = new ArchiveRescueSearchClient({
      provider: 'searxng',
      url: 'http://searxng:8080/search',
      timeoutMs: 1_000,
      maxResults: 5,
      braveFallback: { url: 'https://api.search.brave.com/res/v1/web/search', token: 'brave-key' },
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [{ url: 'https://example.com/a', title: 'From searxng' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(client.search('query', fetchMock as unknown as typeof fetch)).resolves.toMatchObject([
      { url: 'https://example.com/a', title: 'From searxng' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
