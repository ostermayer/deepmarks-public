import { describe, it, expect, vi } from 'vitest';
import { fetchWaybackIfFresh } from '@src/wayback.js';

function makeFetchMock(impl: (url: string) => Promise<Response>) {
  return vi.fn(impl) as unknown as typeof fetch;
}

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function htmlRes(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html' }
  });
}

function compactTimestamp(daysAgo: number): string {
  const ts = new Date(Date.now() - daysAgo * 86400_000);
  return (
    ts.getUTCFullYear().toString().padStart(4, '0') +
    (ts.getUTCMonth() + 1).toString().padStart(2, '0') +
    ts.getUTCDate().toString().padStart(2, '0') +
    ts.getUTCHours().toString().padStart(2, '0') +
    ts.getUTCMinutes().toString().padStart(2, '0') +
    ts.getUTCSeconds().toString().padStart(2, '0')
  );
}

describe('fetchWaybackIfFresh', () => {
  it('returns null when no snapshot is available', async () => {
    const f = makeFetchMock(async () => jsonRes({ archived_snapshots: {} }));
    const out = await fetchWaybackIfFresh('https://x', 30, f);
    expect(out).toBeNull();
  });

  it('reports WHY it missed through onMiss', async () => {
    // 2026-08-21: the IA outage page (HTML with status 200) was
    // indistinguishable from "no snapshot" — every miss was a silent null.
    const reasons: string[] = [];
    const onMiss = (r: string) => reasons.push(r);

    await fetchWaybackIfFresh('https://x', 30,
      makeFetchMock(async () => htmlRes('<html>Internet Archive: Temporarily Offline</html>')), onMiss);
    await fetchWaybackIfFresh('https://x', 30,
      makeFetchMock(async () => new Response('slow down', { status: 503 })), onMiss);
    await fetchWaybackIfFresh('https://x', 30,
      makeFetchMock(async () => jsonRes({ archived_snapshots: {} })), onMiss);
    await fetchWaybackIfFresh('https://x', 30,
      makeFetchMock(async (url) => url.includes('available?')
        ? jsonRes({ archived_snapshots: { closest: {
            available: true, url: 'https://web.archive.org/snap', timestamp: '20000101000000' } } })
        : htmlRes('<html>old</html>')), onMiss);
    await fetchWaybackIfFresh('https://x', 30,
      makeFetchMock(async (url) => url.includes('available?')
        ? jsonRes({ archived_snapshots: { closest: {
            available: true, url: 'https://web.archive.org/snap', timestamp: compactTimestamp(3) } } })
        : new Response('gone', { status: 404 })), onMiss);
    await fetchWaybackIfFresh('https://x', 30,
      makeFetchMock(async () => { throw new Error('network down'); }), onMiss);

    expect(reasons).toEqual([
      'availability-unparseable',
      'availability-http-503',
      'no-snapshot',
      'snapshot-too-old',
      'snapshot-http-404',
      'availability-fetch-failed',
    ]);
  });

  it('returns null when the snapshot is older than maxAgeDays', async () => {
    // Snapshot from year 2000
    const f = makeFetchMock(async (url) => {
      if (url.includes('available?'))
        return jsonRes({
          archived_snapshots: {
            closest: {
              available: true,
              url: 'https://web.archive.org/snap',
              timestamp: '20000101000000'
            }
          }
        });
      return htmlRes('<html>old</html>');
    });
    const out = await fetchWaybackIfFresh('https://x', 30, f);
    expect(out).toBeNull();
  });

  it('returns html buffer + parsed timestamp when fresh', async () => {
    const ts = new Date(Date.now() - 3 * 86400_000); // 3 days ago
    const compact =
      ts.getUTCFullYear().toString().padStart(4, '0') +
      (ts.getUTCMonth() + 1).toString().padStart(2, '0') +
      ts.getUTCDate().toString().padStart(2, '0') +
      ts.getUTCHours().toString().padStart(2, '0') +
      ts.getUTCMinutes().toString().padStart(2, '0') +
      ts.getUTCSeconds().toString().padStart(2, '0');
    const f = makeFetchMock(async (url) => {
      if (url.includes('available?'))
        return jsonRes({
          archived_snapshots: {
            closest: {
              available: true,
              url: 'https://web.archive.org/snap',
              timestamp: compact
            }
          }
        });
      return htmlRes('<html>fresh</html>');
    });
    const out = await fetchWaybackIfFresh('https://x', 30, f);
    expect(out).not.toBeNull();
    expect(out!.html.toString()).toContain('fresh');
    expect(out!.snapshotUrl).toBe('https://web.archive.org/snap');
  });

  it('rejects responses larger than 10MB', async () => {
    const ts = new Date(Date.now() - 3600_000);
    const compact =
      ts.getUTCFullYear().toString().padStart(4, '0') +
      (ts.getUTCMonth() + 1).toString().padStart(2, '0') +
      ts.getUTCDate().toString().padStart(2, '0') +
      ts.getUTCHours().toString().padStart(2, '0') +
      ts.getUTCMinutes().toString().padStart(2, '0') +
      ts.getUTCSeconds().toString().padStart(2, '0');
    const huge = Buffer.alloc(11 * 1024 * 1024, 'a');
    const f = makeFetchMock(async (url) => {
      if (url.includes('available?'))
        return jsonRes({
          archived_snapshots: {
            closest: { available: true, url: 'https://x', timestamp: compact }
          }
        });
      return new Response(huge, { status: 200 });
    });
    expect(await fetchWaybackIfFresh('https://x', 30, f)).toBeNull();
  });

  it('returns null on availability-API failure rather than throwing', async () => {
    const f = makeFetchMock(async () => new Response('boom', { status: 500 }));
    expect(await fetchWaybackIfFresh('https://x', 30, f)).toBeNull();
  });

  it('returns null when timestamp is malformed', async () => {
    const f = makeFetchMock(async () =>
      jsonRes({
        archived_snapshots: {
          closest: { available: true, url: 'https://x', timestamp: 'not-a-timestamp' }
        }
      })
    );
    expect(await fetchWaybackIfFresh('https://x', 30, f)).toBeNull();
  });
});
