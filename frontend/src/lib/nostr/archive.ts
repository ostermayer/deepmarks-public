// Lifetime archive orchestration:
//   1. enqueue /archive/lifetime with NIP-98 auth
//   2. poll /archive/status until done | failed | timeout
//   3. return the resulting Blossom hash + Wayback URL so the bookmark event
//      can be amended with archive tags.

import { api, ApiError, type ArchiveStatus } from '$lib/api/client.js';
import { writable } from 'svelte/store';
import {
  addArchiveKeyToSet,
  assertArchiveKeySignerReady,
  clearPendingArchiveKey,
  generateArchiveKey,
  publishPendingArchiveKey,
  stashPendingArchiveKey,
} from './archive-keys.js';

export interface ArchiveOutcome {
  status: ArchiveStatus;
  preimage: string;
}

export interface ArchiveProgress {
  state: ArchiveStatus['state'];
  detail?: string;
}

export interface ArchiveQueueResult {
  paymentHash: string;
  jobId: string;
  amountSats: 0;
  archiveKey?: string;
}

export interface QueuedArchiveEntry {
  queuedAt: number;
  jobId?: string;
  state?: ArchiveStatus['state'];
  lastCheckedAt?: number;
  error?: string;
}

export interface ArchiveQueueStats {
  queuedUrls: Set<string>;
  failedUrls: Set<string>;
  unknownUrls: Set<string>;
}

/** Queue a lifetime archive without waiting for the worker to finish.
 * Used for high-volume paths such as bookmark imports. */
export async function enqueueArchivePage(opts: {
  url: string;
  tier: 'private' | 'public';
  pubkey: string;
  eventId?: string;
  /** Original bookmark save time, unix seconds. Archive records use it
   *  for their timeline timestamp so archive order matches bookmarks. */
  bookmarkSavedAt?: number;
  lifetime?: boolean;
  mirrorUrls?: string[];
  dedupe?: boolean;
}): Promise<ArchiveQueueResult> {
  if (!opts.lifetime) {
    throw new Error('lifetime membership required to archive pages');
  }
  if (opts.dedupe && !claimArchiveQueueSlot(opts.pubkey, opts.url)) {
    const existing = loadQueuedArchiveEntries(opts.pubkey)[opts.url];
    const jobId = existing?.jobId ?? `queued:${shortClientHash(opts.url)}`;
    return {
      paymentHash: jobId,
      jobId,
      amountSats: 0,
    };
  }
  // A private archive whose key wrap can never publish (signer without
  // NIP-44) is unrecoverable on other devices — fail the enqueue loudly
  // instead of orphaning the key in this device's localStorage.
  if (opts.tier === 'private') {
    try {
      await assertArchiveKeySignerReady(opts.pubkey);
    } catch (err) {
      if (opts.dedupe) releaseArchiveQueueSlot(opts.pubkey, opts.url);
      throw err;
    }
  }
  const archiveKey = opts.tier === 'private' ? generateArchiveKey() : undefined;
  try {
    const result = await api.enqueueLifetimeArchive({
      url: opts.url,
      eventId: opts.eventId,
      tier: opts.tier,
      archiveKey,
      mirrorUrls: opts.mirrorUrls,
      bookmarkSavedAt: opts.bookmarkSavedAt,
      dedupe: opts.dedupe,
    });
    if (opts.dedupe) rememberArchiveQueueJob(opts.pubkey, opts.url, result.jobId);
    if (archiveKey) {
      stashPendingArchiveKey(result.jobId, archiveKey);
      await publishPendingArchiveKey(result.jobId, archiveKey, opts.pubkey).catch((error) => {
        console.warn('Deepmarks archive key pre-sync failed; local stash will retry later:', error);
      });
    }
    return { ...result, archiveKey };
  } catch (error) {
    if (opts.dedupe) releaseArchiveQueueSlot(opts.pubkey, opts.url);
    throw error;
  }
}

const QUEUED_ARCHIVE_PREFIX = 'deepmarks-archive-queued:v1:';
const QUEUED_ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const archiveQueueRevision = writable(0);

function claimArchiveQueueSlot(pubkey: string, url: string): boolean {
  if (typeof localStorage === 'undefined') return true;
  const map = loadQueuedArchiveEntries(pubkey);
  const now = Date.now();
  if (map[url] && now - map[url].queuedAt < QUEUED_ARCHIVE_TTL_MS) return false;
  map[url] = { queuedAt: now };
  saveQueuedArchiveMap(pubkey, map);
  return true;
}

function releaseArchiveQueueSlot(pubkey: string, url: string): void {
  if (typeof localStorage === 'undefined') return;
  const map = loadQueuedArchiveEntries(pubkey);
  delete map[url];
  saveQueuedArchiveMap(pubkey, map);
}

export function loadQueuedArchiveMap(pubkey: string): Record<string, number> {
  return Object.fromEntries(
    Object.entries(loadQueuedArchiveEntries(pubkey)).map(([url, entry]) => [url, entry.queuedAt]),
  );
}

export function loadQueuedArchiveEntries(pubkey: string): Record<string, QueuedArchiveEntry> {
  try {
    const raw = localStorage.getItem(QUEUED_ARCHIVE_PREFIX + pubkey);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    const now = Date.now();
    const out: Record<string, QueuedArchiveEntry> = {};
    for (const [url, at] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = normalizeQueuedArchiveEntry(at);
      if (entry && now - entry.queuedAt < QUEUED_ARCHIVE_TTL_MS) out[url] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

export function isArchiveQueuedRecently(pubkey: string, url: string): boolean {
  return !!loadQueuedArchiveEntries(pubkey)[url];
}

export function queuedArchiveUrls(pubkey: string): Set<string> {
  return archiveQueueStats(pubkey).queuedUrls;
}

export function archiveQueueStats(pubkey: string): ArchiveQueueStats {
  const queuedUrls = new Set<string>();
  const failedUrls = new Set<string>();
  const unknownUrls = new Set<string>();
  const entries = loadQueuedArchiveEntries(pubkey);
  for (const [url, entry] of Object.entries(entries)) {
    if (entry.state === 'failed') failedUrls.add(url);
    else if (!entry.jobId) unknownUrls.add(url);
    else queuedUrls.add(url);
  }
  return { queuedUrls, failedUrls, unknownUrls };
}

export function pruneQueuedArchiveUrls(pubkey: string, completedUrls: Iterable<string>): void {
  if (typeof localStorage === 'undefined') return;
  const map = loadQueuedArchiveEntries(pubkey);
  let changed = false;
  for (const url of completedUrls) {
    if (url in map) {
      delete map[url];
      changed = true;
    }
  }
  if (changed) saveQueuedArchiveMap(pubkey, map);
}

export function releaseFailedArchiveQueueSlots(pubkey: string): number {
  if (typeof localStorage === 'undefined') return 0;
  const map = loadQueuedArchiveEntries(pubkey);
  let released = 0;
  for (const [url, entry] of Object.entries(map)) {
    if (entry.state !== 'failed') continue;
    delete map[url];
    released += 1;
  }
  if (released > 0) saveQueuedArchiveMap(pubkey, map);
  return released;
}

export async function refreshQueuedArchiveStatuses(
  pubkey: string,
  completedUrls: Iterable<string>,
  limit = 100,
): Promise<{ checked: number; completed: number; failed: number }> {
  if (typeof localStorage === 'undefined') return { checked: 0, completed: 0, failed: 0 };
  const completed = new Set(completedUrls);
  const map = loadQueuedArchiveEntries(pubkey);
  let checked = 0;
  let completedCount = 0;
  let failed = 0;
  let changed = false;
  for (const url of completed) {
    if (url in map) {
      delete map[url];
      completedCount += 1;
      changed = true;
    }
  }
  const candidates = Object.entries(map)
    .filter(([, entry]) => !!entry.jobId && !entry.jobId.startsWith('queued:') && entry.state !== 'failed')
    .sort(([, a], [, b]) => (a.lastCheckedAt ?? 0) - (b.lastCheckedAt ?? 0))
    .slice(0, limit);
  await Promise.all(candidates.map(async ([url, entry]) => {
    try {
      const status = await api.archiveStatus(entry.jobId!);
      checked += 1;
      if (status.state === 'done') {
        delete map[url];
        completedCount += 1;
      } else if (status.state === 'failed') {
        map[url] = {
          ...entry,
          state: 'failed',
          lastCheckedAt: Date.now(),
          error: status.error ?? 'archive job failed',
        };
        failed += 1;
      } else {
        map[url] = {
          ...entry,
          state: status.state,
          lastCheckedAt: Date.now(),
          error: undefined,
        };
      }
      changed = true;
    } catch (error) {
      // 404 means the archive job no longer exists on the server
      // (completed and was GC'd from Redis, or never created). Drop
      // it from the local queue so we don't re-poll forever and
      // spam the console with /archive/status/lifetime:hex 404s.
      const isGone = error instanceof ApiError && error.status === 404;
      if (isGone) {
        delete map[url];
        completedCount += 1;
      } else {
        map[url] = {
          ...entry,
          lastCheckedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
      changed = true;
    }
  }));
  if (changed) saveQueuedArchiveMap(pubkey, map);
  return { checked, completed: completedCount, failed };
}

function rememberArchiveQueueJob(pubkey: string, url: string, jobId: string): void {
  if (typeof localStorage === 'undefined') return;
  const map = loadQueuedArchiveEntries(pubkey);
  map[url] = {
    ...(map[url] ?? { queuedAt: Date.now() }),
    jobId,
    state: 'queued',
    lastCheckedAt: Date.now(),
    error: undefined,
  };
  saveQueuedArchiveMap(pubkey, map);
}

function saveQueuedArchiveMap(pubkey: string, map: Record<string, QueuedArchiveEntry>): void {
  try {
    localStorage.setItem(QUEUED_ARCHIVE_PREFIX + pubkey, JSON.stringify(map));
    archiveQueueRevision.update((n) => n + 1);
  } catch {
    // Quota/private-mode failure only disables client-side duplicate suppression.
  }
}

function normalizeQueuedArchiveEntry(value: unknown): QueuedArchiveEntry | null {
  if (typeof value === 'number' && Number.isFinite(value)) return { queuedAt: value };
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<QueuedArchiveEntry>;
  if (typeof candidate.queuedAt !== 'number' || !Number.isFinite(candidate.queuedAt)) return null;
  const state = candidate.state && isArchiveState(candidate.state) ? candidate.state : undefined;
  return {
    queuedAt: candidate.queuedAt,
    jobId: typeof candidate.jobId === 'string' ? candidate.jobId : undefined,
    state,
    lastCheckedAt: typeof candidate.lastCheckedAt === 'number' ? candidate.lastCheckedAt : undefined,
    error: typeof candidate.error === 'string' ? candidate.error : undefined,
  };
}

function isArchiveState(value: unknown): value is ArchiveStatus['state'] {
  return value === 'pending-payment' ||
    value === 'queued' ||
    value === 'archiving' ||
    value === 'mirroring' ||
    value === 'done' ||
    value === 'failed';
}

function shortClientHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16);
}

/**
 * End-to-end lifetime archive enqueue → poll. Yields progress events so
 * the UI can show live status. Throws on terminal failure.
 *
 * Polling cadence: 2s (matches the cadence the mockups display). Cap at
 * `timeoutMs` to avoid leaking sessions.
 */
export async function* archivePage(opts: {
  url: string;
  tier: 'private' | 'public';
  pubkey: string;
  /** Caller has confirmed lifetime locally. Server double-checks via NIP-98. */
  lifetime?: boolean;
  /** User-owned backup Blossom servers to add to the operator mirror set. */
  mirrorUrls?: string[];
  /** Original bookmark save time, unix seconds. */
  bookmarkSavedAt?: number;
  timeoutMs?: number;
}): AsyncGenerator<ArchiveProgress, ArchiveOutcome, void> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  if (!opts.lifetime) {
    throw new Error('lifetime membership required to archive pages');
  }

  const preimage = '';
  // Private archives need a fresh AES-256 key per blob — the worker
  // encrypts the snapshot with it before mirroring, then clears the
  // queued copy. Generate client-side so the plaintext key never lives
  // outside the user's control after enqueue. After the archive completes
  // we publish it to the user's NIP-51 set so any signed-in device can
  // decrypt the snapshot.
  yield { state: 'pending-payment', detail: 'enqueuing lifetime archive…' };
  const result = await enqueueArchivePage(opts);
  const jobId = result.jobId;
  const archiveKey = result.archiveKey;

  const POLL_INTERVAL_MS = 2000;
  const deadline = Date.now() + timeoutMs;
  // Sentinel — guarantees the first observed state is always emitted, even
  // if it happens to be 'queued'.
  let lastState: ArchiveStatus['state'] | null = null;
  while (Date.now() < deadline) {
    const pollStartedAt = Date.now();
    const status = await api.archiveStatus(jobId);
    if (status.state !== lastState) {
      yield {
        state: status.state,
        detail: status.state === 'failed' ? status.error : undefined
      };
      lastState = status.state;
    }
    if (status.state === 'done') {
      // Promote the stashed AES key to the NIP-51 set so any device
      // signed in as this pubkey can decrypt the snapshot. Best-effort:
      // if the publish fails (relay hiccup), the key is still in the
      // localStorage stash and reconcileArchiveKeys will retry when the
      // archive index refreshes.
      if (archiveKey && status.blossomHash) {
        try {
          const hashes = new Set<string>([status.blossomHash]);
          for (const file of status.files ?? []) if (file.blobHash) hashes.add(file.blobHash);
          for (const blobHash of hashes) {
            await addArchiveKeyToSet(blobHash, archiveKey, opts.pubkey);
          }
          clearPendingArchiveKey(jobId);
        } catch {
          // Leave the stash for reconcileArchiveKeys.
        }
      }
      return { status, preimage };
    }
    if (status.state === 'failed') {
      throw new Error(status.error ?? 'archive job failed');
    }
    // Subtract fetch latency so the cadence stays close to POLL_INTERVAL_MS
    // even on slow networks.
    const elapsed = Date.now() - pollStartedAt;
    const wait = Math.max(0, POLL_INTERVAL_MS - elapsed);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error('archive job timed out — check /app/settings later');
}
