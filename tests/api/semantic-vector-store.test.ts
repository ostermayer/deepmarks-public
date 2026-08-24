import { afterEach, describe, expect, it, vi } from 'vitest';

import { QdrantSemanticStore } from '@src/semantic-vector-store.js';
import type { BookmarkDoc } from '@src/search.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QdrantSemanticStore', () => {
  it('uses native Qdrant pagination, counts totals, and excludes delisted events', async () => {
    const requests: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
    const doc = bookmarkDoc({ id: 'hit-event' });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : null;
      requests.push({ method, path: parsed.pathname, body });

      if (method === 'GET' && parsed.pathname === '/collections/bookmarks') {
        return jsonResponse({
          result: {
            points_count: 42,
            indexed_vectors_count: 7,
            config: { params: { vectors: { size: 2 } } },
          },
        });
      }
      if (method === 'PUT' && parsed.pathname === '/collections/bookmarks/index') {
        return jsonResponse({ result: true });
      }
      if (method === 'POST' && parsed.pathname === '/collections/bookmarks/points/query') {
        return jsonResponse({
          result: {
            points: [{
              id: 'point-id',
              score: 0.91,
              payload: { event_id: doc.id, doc },
            }],
          },
        });
      }
      if (method === 'POST' && parsed.pathname === '/collections/bookmarks/points/count') {
        return jsonResponse({ result: { count: 42 } });
      }
      return jsonResponse({ error: 'unexpected request' }, 500);
    }));

    const store = new QdrantSemanticStore(
      { url: 'http://qdrant', collection: 'bookmarks', timeoutMs: 1_000 },
      { warn: vi.fn() },
    );

    const result = await store.searchBookmarks([1, 0], {
      limit: 2,
      offset: 5,
      delistedEventIds: new Set(['blocked-event']),
    });

    expect(result.total).toBe(42);
    expect(result.hits[0]?.event_id).toBe('hit-event');
    const query = requests.find((request) => request.path === '/collections/bookmarks/points/query');
    expect(query?.body).toMatchObject({
      limit: 2,
      offset: 5,
      with_payload: true,
      with_vector: false,
      filter: {
        must_not: [{ key: 'event_id', match: { any: ['blocked-event'] } }],
      },
    });
    expect(requests.some((request) =>
      request.path === '/collections/bookmarks/index' &&
      request.body?.field_name === 'event_id'
    )).toBe(true);
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
