/**
 * Wayback Machine integration — source-only (we never push back to Wayback).
 *
 * Strategy: after live rendering fails, check whether Wayback already
 * has a snapshot less than WAYBACK_MAX_AGE_DAYS old. If so, pull its
 * HTML and use that. This keeps current live pages as the primary
 * source while still giving bot-blocked or otherwise unrenderable
 * pages a second path to a usable archive.
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

/** Why a fetchWaybackIfFresh call produced no snapshot. Reported through
 *  `onMiss` so callers can log/audit it — every miss used to collapse to a
 *  silent null, which hid the 2026-08-21 Internet Archive outage (the
 *  availability API served an HTML outage page; the JSON parse failure was
 *  indistinguishable from "no snapshot exists"). */
export type WaybackMissReason =
  | `availability-http-${number}`
  | 'availability-unparseable'
  | 'availability-fetch-failed'
  | 'no-snapshot'
  | 'bad-snapshot-timestamp'
  | 'snapshot-too-old'
  | `snapshot-http-${number}`
  | 'snapshot-fetch-failed'
  | 'snapshot-empty'
  | 'snapshot-too-large';

export async function fetchWaybackIfFresh(
  url: string,
  maxAgeDays: number,
  fetchImpl: typeof fetch = fetch,
  onMiss: (reason: WaybackMissReason) => void = () => {},
): Promise<WaybackHit | null> {
  const availabilityUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;

  let data: WaybackAvailabilityResponse;
  try {
    const res = await fetchImpl(availabilityUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      onMiss(`availability-http-${res.status}`);
      return null;
    }
    try {
      data = (await res.json()) as WaybackAvailabilityResponse;
    } catch {
      // A 200 that isn't JSON — e.g. the "Internet Archive: Temporarily
      // Offline" outage page.
      onMiss('availability-unparseable');
      return null;
    }
  } catch {
    // Wayback API flaky? Skip this optimization and go straight to rendering.
    onMiss('availability-fetch-failed');
    return null;
  }

  const closest = data.archived_snapshots?.closest;
  if (!closest?.available || !closest.url || !closest.timestamp) {
    onMiss('no-snapshot');
    return null;
  }

  const capturedAt = parseWaybackTimestamp(closest.timestamp);
  if (capturedAt === null) {
    onMiss('bad-snapshot-timestamp');
    return null;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - capturedAt > maxAgeDays * 86_400) {
    onMiss('snapshot-too-old');
    return null;
  }

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
    if (!res.ok) {
      onMiss(`snapshot-http-${res.status}`);
      return null;
    }
    const arr = new Uint8Array(await res.arrayBuffer());
    html = Buffer.from(arr);
  } catch {
    onMiss('snapshot-fetch-failed');
    return null;
  }

  if (html.byteLength === 0) {
    onMiss('snapshot-empty');
    return null;
  }
  // Sanity cap — 10MB. Wayback occasionally returns huge aggregated
  // pages; clip to a reasonable archive size.
  if (html.byteLength > 10 * 1024 * 1024) {
    onMiss('snapshot-too-large');
    return null;
  }

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
