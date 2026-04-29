/**
 * Wayback Machine integration — source-only (we never push back to Wayback).
 *
 * Strategy: before spinning up Chromium, check whether Wayback already
 * has a snapshot less than WAYBACK_MAX_AGE_DAYS old. If so, pull its
 * HTML and use that. Saves render cost, often succeeds on paywalled
 * or bot-blocked sites that we couldn't render ourselves anyway.
 */

interface WaybackAvailabilityResponse {
  archived_snapshots?: {
    closest?: {
      status?: string;
      available?: boolean;
      url?: string;
      timestamp?: string;
    };
  };
}

export interface WaybackHit {
  snapshotUrl: string;
  /** Parsed timestamp of the snapshot (unix seconds) */
  capturedAt: number;
  /** The raw HTML body of the snapshot */
  html: Buffer;
}

const UA = 'Deepmarks-Archive/1.0 (+https://deepmarks.org/bot)';

export async function fetchWaybackIfFresh(
  url: string,
  maxAgeDays: number,
  fetchImpl: typeof fetch = fetch,
): Promise<WaybackHit | null> {
  const availabilityUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;

  let data: WaybackAvailabilityResponse;
  try {
    const res = await fetchImpl(availabilityUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    data = (await res.json()) as WaybackAvailabilityResponse;
  } catch {
    // Wayback API flaky? Skip this optimization and go straight to rendering.
    return null;
  }

  const closest = data.archived_snapshots?.closest;
  if (!closest?.available || !closest.url || !closest.timestamp) return null;

  const capturedAt = parseWaybackTimestamp(closest.timestamp);
  if (capturedAt === null) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - capturedAt > maxAgeDays * 86_400) return null;

  // Pull the snapshot's raw HTML. Wayback-rewritten URLs include an
  // `id_` suffix hack for "original, unmodified" content, but we want
  // the rewritten version — it's what's actually served.
  let html: Buffer;
  try {
    const res = await fetchImpl(closest.url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const arr = new Uint8Array(await res.arrayBuffer());
    html = Buffer.from(arr);
  } catch {
    return null;
  }

  if (html.byteLength === 0) return null;
  // Sanity cap — 10MB. Wayback occasionally returns huge aggregated
  // pages; clip to a reasonable archive size.
  if (html.byteLength > 10 * 1024 * 1024) return null;

  return { snapshotUrl: closest.url, capturedAt, html };
}

/** Parse Wayback's compact timestamp format (YYYYMMDDhhmmss). */
function parseWaybackTimestamp(ts: string): number | null {
  if (!/^\d{14}$/.test(ts)) return null;
  const year = parseInt(ts.slice(0, 4), 10);
  const month = parseInt(ts.slice(4, 6), 10) - 1;
  const day = parseInt(ts.slice(6, 8), 10);
  const hour = parseInt(ts.slice(8, 10), 10);
  const minute = parseInt(ts.slice(10, 12), 10);
  const second = parseInt(ts.slice(12, 14), 10);
  const ms = Date.UTC(year, month, day, hour, minute, second);
  if (isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}
