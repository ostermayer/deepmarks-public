// Client-side mirror of the server's escalating terminal-failure cooldown
// (api/src/archive-failures.ts). The server refuses re-enqueues of
// recently-failed URLs with a `queued:recent-failure` sentinel; this ledger
// keeps the backfill loop from even sending those requests. It survives the
// queue-slot map's release/requeue cycle (which forgets failure history)
// and the flat 7-day slot TTL: each consecutive failure doubles the wait,
// 6h base up to the 30-day cap, and a later success clears the entry.
// Incident: docs/incidents/2026-08-21-archive-backfill-retry-loop.md

const BACKOFF_PREFIX = 'deepmarks-archive-backoff:v1:';
const BASE_BACKOFF_MS = 6 * 60 * 60 * 1000;
const MAX_BACKOFF_MS = 30 * 24 * 60 * 60 * 1000;
/** Bound the per-pubkey ledger — a huge dead import must not grow
 *  localStorage without limit. Oldest entries fall off first; the server
 *  gate still covers anything evicted. */
const MAX_TRACKED_URLS = 2000;

export interface ArchiveBackoffEntry {
  failures: number;
  lastFailureAt: number;
}

/** How long `failures` consecutive terminal failures suppress re-submitting
 *  a URL: 6h · 2^(n-1), capped at 30 days — same curve as the server. */
export function archiveBackoffWindowMs(failures: number): number {
  const strikes = Math.max(1, Math.floor(failures));
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.min(strikes - 1, 8), MAX_BACKOFF_MS);
}

/** True while the URL's last recorded failure is inside its backoff window —
 *  backfill candidates with an active backoff are skipped without a request. */
export function isArchiveBackoffActive(pubkey: string, url: string, now = Date.now()): boolean {
  const entry = loadBackoffMap(pubkey, now)[url];
  if (!entry) return false;
  return now - entry.lastFailureAt < archiveBackoffWindowMs(entry.failures);
}

/** Record one terminal failure (or a server `queued:recent-failure` /
 *  `queued:permanent-failure` sentinel, which means the server's own
 *  cooldown is active) for this owner+URL. */
export function recordArchiveFailureBackoff(pubkey: string, url: string, now = Date.now()): void {
  if (typeof localStorage === 'undefined') return;
  const map = loadBackoffMap(pubkey, now);
  const previous = map[url];
  map[url] = { failures: (previous?.failures ?? 0) + 1, lastFailureAt: now };
  saveBackoffMap(pubkey, map);
}

/** Forget backoff state for URLs that now have a completed archive. */
export function clearArchiveBackoff(pubkey: string, urls: Iterable<string>): void {
  if (typeof localStorage === 'undefined') return;
  const map = loadBackoffMap(pubkey);
  let changed = false;
  for (const url of urls) {
    if (url in map) {
      delete map[url];
      changed = true;
    }
  }
  if (changed) saveBackoffMap(pubkey, map);
}

function loadBackoffMap(pubkey: string, now = Date.now()): Record<string, ArchiveBackoffEntry> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(BACKOFF_PREFIX + pubkey);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, ArchiveBackoffEntry> = {};
    for (const [url, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = normalizeEntry(value);
      // Entries past the maximum window are inert — drop them on load.
      if (entry && now - entry.lastFailureAt < MAX_BACKOFF_MS) out[url] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

function saveBackoffMap(pubkey: string, map: Record<string, ArchiveBackoffEntry>): void {
  let entries = Object.entries(map);
  if (entries.length > MAX_TRACKED_URLS) {
    entries = entries
      .sort(([, a], [, b]) => b.lastFailureAt - a.lastFailureAt)
      .slice(0, MAX_TRACKED_URLS);
  }
  try {
    localStorage.setItem(BACKOFF_PREFIX + pubkey, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Quota/private-mode failure only loses client-side politeness — the
    // server-side cooldown gate still refuses the re-enqueue.
  }
}

function normalizeEntry(value: unknown): ArchiveBackoffEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ArchiveBackoffEntry>;
  if (typeof candidate.failures !== 'number' || !Number.isFinite(candidate.failures) || candidate.failures < 1) return null;
  if (typeof candidate.lastFailureAt !== 'number' || !Number.isFinite(candidate.lastFailureAt)) return null;
  return { failures: Math.floor(candidate.failures), lastFailureAt: candidate.lastFailureAt };
}
