import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';

import { rescueArchiveFailure } from '@src/archive-rescue.js';
import type { ArchiveFailureRecord } from '@src/archive-failures.js';
import type { ArchiveRescueSearchClient } from '@src/archive-rescue-search.js';
import type { DeepInfraClient } from '@src/llm.js';
import type { PurchaseStore } from '@src/queue.js';
import type { PurchaseRecord } from '@src/types.js';

class FakeRedis {
  kv = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    if (args.includes('NX') && this.kv.has(key)) return null;
    this.kv.set(key, value);
    return 'OK';
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    const isNew = !hash.has(field);
    hash.set(field, value);
    this.hashes.set(key, hash);
    return isNew ? 1 : 0;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }
}

class FakePurchaseStore {
  records: PurchaseRecord[] = [];
  queued: PurchaseRecord[] = [];

  async create(record: PurchaseRecord): Promise<void> {
    this.records.push({ ...record });
  }

  async markPaid(paymentHash: string): Promise<PurchaseRecord | null> {
    const record = this.records.find((item) => item.paymentHash === paymentHash);
    if (!record) return null;
    record.status = 'paid';
    record.paidAt = 1_700_000_001;
    return record;
  }

  async enqueueArchiveJob(record: PurchaseRecord): Promise<void> {
    this.queued.push({ ...record });
  }

  async rollbackToPending(): Promise<void> {}
}

const publicDns = async () => [{ address: '93.184.216.34' }];

// A response body large enough to clear the rescue's minimum-content floor
// (thin bot-challenge pages are rejected). Markers are embedded so content
// checks like the tweet-id binding can match.
function bigHtml(...markers: string[]): string {
  return `<html><body>${markers.join(' ')}<main>${'<p>archived content paragraph.</p>'.repeat(120)}</main></body></html>`;
}

describe('archive rescue', () => {
  it('does not touch private archive failures', async () => {
    const fetchMock = vi.fn();
    const llm = {
      enabled: true,
      suggestArchiveRescue: vi.fn(),
    };

    const result = await rescueArchiveFailure(
      deps({ llm: llm as unknown as Pick<DeepInfraClient, 'enabled' | 'suggestArchiveRescue'> }),
      failure({ tier: 'private' }),
      { fetch: fetchMock as unknown as typeof fetch, dnsLookup: publicDns },
    );

    expect(result).toMatchObject({ eligible: false, skippedReason: 'private-archive' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(llm.suggestArchiveRescue).not.toHaveBeenCalled();
  });

  it('enqueues a verified public known-migration rescue job', async () => {
    const purchases = new FakePurchaseStore();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://archive.org/wayback/available')) {
        return jsonResponse({ archived_snapshots: {} });
      }
      if (url === 'https://glitch.com/community/community-picks') {
        return new Response(bigHtml('ok'), { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('missing', { status: 404 });
    });

    const result = await rescueArchiveFailure(
      deps({ purchases }),
      failure({
        url: 'https://gomix.com/community/community-picks',
        eventId: 'e'.repeat(64),
        mirrorUrls: ['https://mirror.example'],
      }),
      { fetch: fetchMock as unknown as typeof fetch, dnsLookup: publicDns },
    );

    expect(result.enqueuedJobId).toMatch(/^rescue:[0-9a-f]{32}$/);
    expect(result.enqueuedUrl).toBe('https://glitch.com/community/community-picks');
    expect(purchases.queued).toHaveLength(1);
    expect(purchases.queued[0]).toMatchObject({
      url: 'https://glitch.com/community/community-picks',
      originalUrl: 'https://gomix.com/community/community-picks',
      userPubkey: 'a'.repeat(64),
      eventId: 'e'.repeat(64),
      tier: 'public',
      mirrorUrls: ['https://mirror.example'],
    });
  });

  it('verifies candidates during dry-run without enqueueing', async () => {
    const purchases = new FakePurchaseStore();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://archive.org/wayback/available')) {
        return jsonResponse({ archived_snapshots: {} });
      }
      if (url === 'https://glitch.com/community/community-picks') {
        return new Response(bigHtml('ok'), { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('missing', { status: 404 });
    });

    const result = await rescueArchiveFailure(
      deps({ purchases }),
      failure({ url: 'https://gomix.com/community/community-picks' }),
      { dryRun: true, fetch: fetchMock as unknown as typeof fetch, dnsLookup: publicDns },
    );

    expect(result.verifiedCandidates[0]?.url).toBe('https://glitch.com/community/community-picks');
    expect(result.enqueuedJobId).toBeUndefined();
    expect(purchases.queued).toHaveLength(0);
  });

  it('uses web search results as live archive candidates', async () => {
    const purchases = new FakePurchaseStore();
    const archiveUrl = 'https://web.archive.org/web/20260101000000/https://example.com/post';
    const archiveOrgDownload = 'https://archive.org/download/unrelated/example.zip';
    const unrelatedSameHost = 'https://example.com/other-post';
    const search = {
      enabled: true,
      search: vi.fn(async () => ([
        {
          url: archiveOrgDownload,
          title: 'Unrelated archive.org download',
          snippet: 'Not a Wayback snapshot of this page.',
        },
        {
          url: unrelatedSameHost,
          title: 'Different same-host page',
          snippet: 'This is not the failed page.',
        },
        {
          url: archiveUrl,
          title: 'Example post - archived copy',
          snippet: 'Archived copy of https://example.com/post',
        },
      ])),
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://archive.org/wayback/available')) {
        return jsonResponse({ archived_snapshots: {} });
      }
      if (url === archiveUrl) {
        return new Response(bigHtml('archived'), { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('missing', { status: 404 });
    });

    const result = await rescueArchiveFailure(
      deps({ purchases, search: search as unknown as Pick<ArchiveRescueSearchClient, 'enabled' | 'search'> }),
      failure({ url: 'https://example.com/post' }),
      { fetch: fetchMock as unknown as typeof fetch, dnsLookup: publicDns },
    );

    expect(search.search).toHaveBeenCalled();
    expect(result.candidates.some((candidate) => candidate.url === archiveOrgDownload)).toBe(false);
    expect(result.candidates.some((candidate) => candidate.url === unrelatedSameHost)).toBe(false);
    expect(result.enqueuedUrl).toBe(archiveUrl);
    expect(purchases.queued[0]).toMatchObject({
      url: archiveUrl,
      originalUrl: 'https://example.com/post',
    });
  });

  it('lets the LLM range across public hosts but still blocks SSRF targets', async () => {
    const purchases = new FakePurchaseStore();
    const altSource = 'https://some-other-archive.example/copy-of-the-post';
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://archive.org/wayback/available')) return jsonResponse({ archived_snapshots: {} });
      if (url === altSource) return new Response(bigHtml('a public copy of the post'), { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response('missing', { status: 404 });
    });
    const llm = {
      enabled: true,
      suggestArchiveRescue: vi.fn(async () => ({
        candidates: [
          { url: 'http://127.0.0.1/admin', reason: 'ssrf target', confidence: 1 },
          { url: altSource, reason: 'public copy on an unrelated host', confidence: 0.9 },
        ],
        searchQueries: ['example public mirror'],
      })),
    };

    const result = await rescueArchiveFailure(
      deps({ purchases, llm: llm as unknown as Pick<DeepInfraClient, 'enabled' | 'suggestArchiveRescue'> }),
      failure({ url: 'https://example.com/post' }),
      { fetch: fetchMock as unknown as typeof fetch, dnsLookup: publicDns },
    );

    const fetchedUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    // SSRF target never reaches the network.
    expect(fetchedUrls.some((url) => url.includes('127.0.0.1'))).toBe(false);
    // An unrelated *public* host the LLM suggested is now allowed + archived.
    expect(fetchedUrls.some((url) => url.includes('some-other-archive.example'))).toBe(true);
    expect(result.enqueuedUrl).toBe(altSource);
    expect(result.searchQueries).toContain('example public mirror');
  });

  it('rescues a paywalled scholarly article via an open-access PDF (Lancet → OA PDF)', async () => {
    const purchases = new FakePurchaseStore();
    const oaPdf = 'https://europepmc.org/articles/PMC9999999/pdf';
    const lancetUrl = 'https://www.thelancet.com/journals/lancet/article/PIIS0140-6736(26)00918-9/fulltext';
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://archive.org/wayback/available')) return jsonResponse({ archived_snapshots: {} });
      // OpenAlex/Crossref metadata exposes the open-access PDF location.
      if (url.startsWith('https://api.openalex.org/works/')) return jsonResponse({ best_oa_location: { pdf_url: oaPdf } });
      if (url.startsWith('https://api.crossref.org/works/')) return jsonResponse({ message: {} });
      // The OA PDF verifies as a real PDF...
      if (url === oaPdf) return new Response(bigHtml('%PDF-1.7 open access pdf'), { status: 200, headers: { 'content-type': 'application/pdf' } });
      // ...while the same-host publisher variants stay paywalled.
      return new Response('paywall', { status: 403 });
    });

    const result = await rescueArchiveFailure(
      deps({ purchases }),
      failure({ url: lancetUrl }),
      { fetch: fetchMock as unknown as typeof fetch, dnsLookup: publicDns },
    );

    expect(result.candidates.some((c) => c.url === oaPdf && c.source === 'scholarly-pdf')).toBe(true);
    expect(result.enqueuedUrl).toBe(oaPdf);
    expect(purchases.queued[0]).toMatchObject({ url: oaPdf, originalUrl: lancetUrl, tier: 'public' });
    // PII/DOI drove searxng filetype:pdf queries too.
    expect(result.searchQueries.some((q) => /filetype:pdf/i.test(q))).toBe(true);
  });

  it('does not rescue media archive failures (best-effort, not webpages)', async () => {
    const fetchMock = vi.fn();
    const result = await rescueArchiveFailure(
      deps(),
      failure({ url: 'https://twitter.com/x/status/123', kind: 'media' }),
      { fetch: fetchMock as unknown as typeof fetch, dnsLookup: publicDns },
    );
    expect(result).toMatchObject({ eligible: false, skippedReason: 'non-webpage-archive' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rescues a blocked x.com tweet by rebuilding it via the FixTweet API', async () => {
    const purchases = new FakePurchaseStore();
    const tweet = 'https://x.com/daniellefong/status/2047460388976185509';
    const canonical = 'https://x.com/daniellefong/status/2047460388976185509';
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://archive.org/wayback/available')) return jsonResponse({ archived_snapshots: {} });
      // FixTweet serves the tweet JSON; the worker rebuilds it from the id.
      if (url.startsWith('https://api.fxtwitter.com/'))
        return jsonResponse({ code: 200, tweet: { id: '2047460388976185509', text: 'hi' } });
      return new Response('blocked', { status: 403 });
    });

    const result = await rescueArchiveFailure(
      deps({ purchases }),
      failure({ url: tweet }),
      { fetch: fetchMock as unknown as typeof fetch, dnsLookup: publicDns },
    );

    expect(result.candidates.some((c) => c.url === canonical && c.source === 'social-mirror')).toBe(true);
    expect(result.enqueuedUrl).toBe(canonical);
    expect(purchases.queued[0]).toMatchObject({ url: canonical, originalUrl: tweet, tier: 'public' });
    // No Nitter/xcancel mirror was ever fetched.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('nitter') || String(u).includes('xcancel'))).toBe(false);
  });

  it('rebuilds a tweet bookmarked on a dead Nitter mirror via FixTweet', async () => {
    const purchases = new FakePurchaseStore();
    const nitter = 'https://nitter.net/howaboua/status/2047077497855213663';
    const canonical = 'https://x.com/howaboua/status/2047077497855213663';
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://archive.org/wayback/available')) return jsonResponse({ archived_snapshots: {} });
      if (url.startsWith('https://api.fxtwitter.com/'))
        return jsonResponse({ code: 200, tweet: { id: '2047077497855213663', text: 'people of pi' } });
      // nitter.net is dead — empty 200, never a usable archive.
      if (url.startsWith('https://nitter.net/')) return new Response('', { status: 200 });
      return new Response('blocked', { status: 403 });
    });

    const result = await rescueArchiveFailure(
      deps({ purchases }),
      failure({ url: nitter }),
      { fetch: fetchMock as unknown as typeof fetch, dnsLookup: publicDns },
    );

    expect(result.enqueuedUrl).toBe(canonical);
    expect(purchases.queued[0]).toMatchObject({ url: canonical, originalUrl: nitter, tier: 'public' });
  });

  it('rejects a wrong-tweet rescue even when the LLM suggests it', async () => {
    const purchases = new FakePurchaseStore();
    const tweet = 'https://x.com/alice/status/111111111111111';
    const canonical = 'https://x.com/alice/status/111111111111111';
    const wrongMirror = 'https://xcancel.com/bob/status/999999999999999';
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://archive.org/wayback/available')) return jsonResponse({ archived_snapshots: {} });
      // FixTweet serves the right tweet (id-bound); the wrong-id mirror page is
      // a real but DIFFERENT tweet, fetched as HTML on the generic path.
      if (url.startsWith('https://api.fxtwitter.com/alice/'))
        return jsonResponse({ code: 200, tweet: { id: '111111111111111', text: 'right' } });
      if (url === wrongMirror) return new Response(bigHtml('tweet 999999999999999'), { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response('blocked', { status: 403 });
    });
    const llm = {
      enabled: true,
      suggestArchiveRescue: vi.fn(async () => ({
        candidates: [{ url: wrongMirror, reason: 'wrong tweet mirror', confidence: 1 }],
        searchQueries: [],
      })),
    };

    const result = await rescueArchiveFailure(
      deps({ purchases, llm: llm as unknown as Pick<DeepInfraClient, 'enabled' | 'suggestArchiveRescue'> }),
      failure({ url: tweet }),
      { fetch: fetchMock as unknown as typeof fetch, dnsLookup: publicDns },
    );

    // The wrong-tweet mirror is rejected by the same-id binding...
    expect(result.verifiedCandidates.find((c) => c.url === wrongMirror)).toBeUndefined();
    expect(result.enqueuedUrl).not.toBe(wrongMirror);
    // ...while the right tweet is rebuilt via FixTweet at its canonical URL.
    expect(result.enqueuedUrl).toBe(canonical);
  });
});

function deps(overrides: {
  purchases?: FakePurchaseStore;
  llm?: Pick<DeepInfraClient, 'enabled' | 'suggestArchiveRescue'>;
  search?: Pick<ArchiveRescueSearchClient, 'enabled' | 'search'>;
} = {}) {
  return {
    redis: new FakeRedis() as unknown as Redis,
    purchases: (overrides.purchases ?? new FakePurchaseStore()) as unknown as PurchaseStore,
    llm: overrides.llm ?? {
      enabled: false,
      suggestArchiveRescue: vi.fn(),
    },
    search: overrides.search,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

function failure(overrides: Partial<ArchiveFailureRecord> = {}): ArchiveFailureRecord {
  return {
    jobId: 'lifetime:abc123',
    ownerPubkey: 'a'.repeat(64),
    url: 'https://example.com/post',
    reason: 'site-blocked',
    message: 'Site blocked the archive capture.',
    failedAt: 1_700_000_000,
    tier: 'public',
    kind: 'webpage',
    ...overrides,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
