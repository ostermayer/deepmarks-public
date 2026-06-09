import type { ArchiveRecord } from '$lib/api/client';
import {
  getArchiveKeyMap,
  getPendingArchiveKey,
  reconcileArchiveKeys,
  archiveKeyJobMapKey,
  type ArchiveKeyMap,
} from '$lib/nostr/archive-keys';
import { archiveQueueRevision } from '$lib/nostr/archive';
import { reconcileExtensionArchiveKeys } from '$lib/nostr/deepmarks-extension';

const MISSING_KEY_PREFIX = 'deepmarks-archive-missing-key:v1:';
const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_RETRY_COOLDOWN_MS = DAY_MS;
const AUTO_RETRY_WINDOW_MS = 14 * DAY_MS;
const MAX_AUTO_RETRIES = 3;

interface MissingKeyEntry {
  url: string;
  firstSeenAt: number;
  lastSeenAt: number;
  attempts: number;
  lastQueuedAt?: number;
  lastBlobHash?: string;
  lastJobId?: string;
  exhaustedAt?: number;
}

type MissingKeyMap = Record<string, MissingKeyEntry>;

export interface ArchiveKeyHealth {
  usable: ArchiveRecord[];
  missing: ArchiveRecord[];
  audited: boolean;
}

export interface MissingKeyRetrySummary {
  queued: number;
  skipped: number;
  exhausted: number;
}

export function archiveKeyForRecord(map: ArchiveKeyMap | undefined, rec: ArchiveRecord): string | undefined {
  if (!map) return undefined;
  for (const blobHash of archiveBlobHashes(rec)) {
    const key = map[blobHash];
    if (key) return key;
  }
  const jobKey = archiveKeyJobMapKey(rec.jobId);
  if (jobKey && map[jobKey]) return map[jobKey];
  return undefined;
}

export async function auditArchiveKeyHealth(
  records: ArchiveRecord[],
  pubkey: string,
): Promise<ArchiveKeyHealth> {
  const privateRecords = records.filter((rec) => rec.tier === 'private');
  if (privateRecords.length === 0) {
    clearMissingArchiveKeys(pubkey, records);
    return { usable: records, missing: [], audited: true };
  }

  await reconcileArchiveKeys(privateRecords, pubkey).catch(() => undefined);
  await reconcileExtensionArchiveKeys().catch(() => undefined);

  let keyMap: ArchiveKeyMap;
  try {
    keyMap = await getArchiveKeyMap(pubkey, { force: true });
  } catch {
    // Signer or relay failure means we cannot prove any key is missing.
    // Keep the archive list unchanged rather than hiding good records.
    return { usable: records, missing: [], audited: false };
  }

  const usable: ArchiveRecord[] = [];
  const missing: ArchiveRecord[] = [];
  for (const rec of records) {
    if (rec.tier !== 'private' || hasRecoverableArchiveKey(rec, keyMap)) usable.push(rec);
    else missing.push(rec);
  }
  rememberArchiveKeyHealth(pubkey, usable, missing);
  return { usable, missing, audited: true };
}

export function missingKeyArchiveUrls(pubkey: string | null | undefined): Set<string> {
  if (!pubkey) return new Set();
  return new Set(Object.keys(readMissingMap(pubkey)));
}

export function hasRetryableMissingKeyArchives(pubkey: string | null | undefined): boolean {
  if (!pubkey) return false;
  const now = Date.now();
  return Object.values(readMissingMap(pubkey)).some((entry) => {
    if (entry.lastQueuedAt && now - entry.lastQueuedAt < AUTO_RETRY_COOLDOWN_MS) return false;
    return entry.attempts < MAX_AUTO_RETRIES || now - entry.firstSeenAt >= AUTO_RETRY_WINDOW_MS;
  });
}

export function missingKeyRetryCandidates(
  pubkey: string,
  records: readonly ArchiveRecord[],
  opts: { force?: boolean } = {},
): { candidates: ArchiveRecord[]; skipped: number; exhausted: number } {
  const map = readMissingMap(pubkey);
  const now = Date.now();
  const candidates: ArchiveRecord[] = [];
  let skipped = 0;
  let exhausted = 0;

  for (const rec of records) {
    const entry = map[rec.url];
    if (!entry) {
      candidates.push(rec);
      continue;
    }
    if (!opts.force) {
      if (entry.lastQueuedAt && now - entry.lastQueuedAt < AUTO_RETRY_COOLDOWN_MS) {
        skipped += 1;
        continue;
      }
      if (entry.attempts >= MAX_AUTO_RETRIES && now - entry.firstSeenAt < AUTO_RETRY_WINDOW_MS) {
        exhausted += 1;
        continue;
      }
    }
    candidates.push(rec);
  }

  return { candidates, skipped, exhausted };
}

export function recordMissingKeyArchiveRetryQueued(
  pubkey: string,
  rec: ArchiveRecord,
  jobId: string,
): void {
  const map = readMissingMap(pubkey);
  const now = Date.now();
  const existing = normalizeRetryWindow(map[rec.url], now);
  map[rec.url] = {
    url: rec.url,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    attempts: (existing?.attempts ?? 0) + 1,
    lastQueuedAt: now,
    lastBlobHash: rec.blobHash,
    lastJobId: jobId,
    exhaustedAt: existing?.exhaustedAt,
  };
  if (map[rec.url]!.attempts >= MAX_AUTO_RETRIES) {
    map[rec.url]!.exhaustedAt = now;
  }
  writeMissingMap(pubkey, map);
}

function hasRecoverableArchiveKey(rec: ArchiveRecord, keyMap: ArchiveKeyMap): boolean {
  if (archiveKeyForRecord(keyMap, rec)) return true;
  return !!(rec.jobId && getPendingArchiveKey(rec.jobId));
}

function archiveBlobHashes(rec: Pick<ArchiveRecord, 'blobHash' | 'files'>): string[] {
  const hashes = new Set<string>();
  if (rec.blobHash) hashes.add(rec.blobHash);
  for (const file of rec.files ?? []) {
    if (file.blobHash) hashes.add(file.blobHash);
  }
  return [...hashes];
}

function rememberArchiveKeyHealth(
  pubkey: string,
  usable: readonly ArchiveRecord[],
  missing: readonly ArchiveRecord[],
): void {
  const map = readMissingMap(pubkey);
  let changed = false;
  for (const rec of usable) {
    if (map[rec.url]) {
      delete map[rec.url];
      changed = true;
    }
  }
  const now = Date.now();
  for (const rec of missing) {
    const existing = normalizeRetryWindow(map[rec.url], now);
    map[rec.url] = {
      url: rec.url,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      attempts: existing?.attempts ?? 0,
      lastQueuedAt: existing?.lastQueuedAt,
      lastBlobHash: rec.blobHash,
      lastJobId: rec.jobId || existing?.lastJobId,
      exhaustedAt: existing?.exhaustedAt,
    };
    changed = true;
  }
  if (changed) writeMissingMap(pubkey, map);
}

function clearMissingArchiveKeys(pubkey: string, records: readonly ArchiveRecord[]): void {
  const map = readMissingMap(pubkey);
  let changed = false;
  for (const rec of records) {
    if (!map[rec.url]) continue;
    delete map[rec.url];
    changed = true;
  }
  if (changed) writeMissingMap(pubkey, map);
}

function normalizeRetryWindow(entry: MissingKeyEntry | undefined, now: number): MissingKeyEntry | undefined {
  if (!entry) return undefined;
  if (now - entry.firstSeenAt <= AUTO_RETRY_WINDOW_MS) return entry;
  return {
    ...entry,
    firstSeenAt: now,
    attempts: 0,
    lastQueuedAt: undefined,
    exhaustedAt: undefined,
  };
}

function readMissingMap(pubkey: string): MissingKeyMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(MISSING_KEY_PREFIX + pubkey);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    const out: MissingKeyMap = {};
    for (const [url, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = normalizeEntry(url, value);
      if (entry) out[url] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMissingMap(pubkey: string, map: MissingKeyMap): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(MISSING_KEY_PREFIX + pubkey, JSON.stringify(map));
    archiveQueueRevision.update((n) => n + 1);
  } catch {
    // Losing this cache only disables client-side suppression/retry memory.
  }
}

function normalizeEntry(url: string, value: unknown): MissingKeyEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<MissingKeyEntry>;
  if (typeof candidate.firstSeenAt !== 'number' || !Number.isFinite(candidate.firstSeenAt)) return null;
  if (typeof candidate.lastSeenAt !== 'number' || !Number.isFinite(candidate.lastSeenAt)) return null;
  return {
    url,
    firstSeenAt: candidate.firstSeenAt,
    lastSeenAt: candidate.lastSeenAt,
    attempts: typeof candidate.attempts === 'number' && Number.isFinite(candidate.attempts)
      ? Math.max(0, Math.floor(candidate.attempts))
      : 0,
    lastQueuedAt: typeof candidate.lastQueuedAt === 'number' ? candidate.lastQueuedAt : undefined,
    lastBlobHash: typeof candidate.lastBlobHash === 'string' ? candidate.lastBlobHash : undefined,
    lastJobId: typeof candidate.lastJobId === 'string' ? candidate.lastJobId : undefined,
    exhaustedAt: typeof candidate.exhaustedAt === 'number' ? candidate.exhaustedAt : undefined,
  };
}
