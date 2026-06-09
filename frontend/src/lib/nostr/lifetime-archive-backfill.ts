import { get, writable, type Unsubscriber } from 'svelte/store';
import { browser } from '$app/environment';
import { api, type ArchiveQueueStatus, type ArchiveRecord } from '$lib/api/client';
import {
  enqueueArchivePage,
  isArchiveQueuedRecently,
  pruneQueuedArchiveUrls,
  releaseFailedArchiveQueueSlots,
  refreshQueuedArchiveStatuses,
} from '$lib/nostr/archive';
import {
  auditArchiveKeyHealth,
  hasRetryableMissingKeyArchives,
  missingKeyRetryCandidates,
  recordMissingKeyArchiveRetryQueued,
} from '$lib/archives/key-health';
import { queueEligibleMediaArchives } from '$lib/media-archive';
import type { ParsedBookmark } from '$lib/nostr/bookmarks';
import { getLifetimeStatus } from '$lib/nostr/lifetime-status';
import { ownBookmarks } from '$lib/stores/own-bookmarks';
import {
  canSign,
  currentSession,
  refreshBrowserExtensionSigner,
  session,
  sessionRestoring,
} from '$lib/stores/session';
import { replaceMyArchiveRecords } from '$lib/stores/my-archives';
import { userSettings } from '$lib/stores/user-settings';

const LS_PREFIX = 'deepmarks-lifetime-archive-backfill:v1:';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_QUEUE_PER_RUN = 250;
const CONTINUE_DELAY_MS = 5_000;
const QUEUE_POLL_DELAY_MS = 30_000;
let started = false;
let activeFor: string | null = null;
let lifetimePubkey: string | null = null;
let stopLifetime: Unsubscriber | null = null;
let scheduled = false;
let queuePollTimer: number | null = null;

export interface LifetimeArchiveBackfillStatus {
  state: 'idle' | 'checking' | 'queueing' | 'queued' | 'complete' | 'paused' | 'error';
  pubkey: string | null;
  totalMissing: number;
  queued: number;
  skipped: number;
  failed: number;
  serverPending?: number;
  serverRunning?: number;
  serverArchivedTotal?: number;
  message: string;
  updatedAt: number;
}

export const archiveBackfillStatus = writable<LifetimeArchiveBackfillStatus>({
  state: 'idle',
  pubkey: null,
  totalMissing: 0,
  queued: 0,
  skipped: 0,
  failed: 0,
  message: '',
  updatedAt: 0,
});

export function startLifetimeArchiveBackfill(): void {
  if (!browser || started) return;
  started = true;
  session.subscribe(($session) => {
    if (!$session.pubkey) activeFor = null;
    if ($session.pubkey !== lifetimePubkey) {
      stopLifetime?.();
      lifetimePubkey = $session.pubkey;
      stopLifetime = lifetimePubkey
        ? getLifetimeStatus(lifetimePubkey).subscribe(() => scheduleMaybe())
        : null;
    }
    scheduleMaybe();
  });
  canSign.subscribe(() => scheduleMaybe());
  userSettings.subscribe(() => scheduleMaybe());
  ownBookmarks.subscribe(() => scheduleMaybe());
}

function scheduleMaybe(): void {
  if (scheduled) return;
  scheduled = true;
  window.setTimeout(() => {
    scheduled = false;
    void maybeBackfill();
  }, 0);
}

export async function retryFailedArchives(): Promise<void> {
  await maybeBackfill(true, { retryFailed: true });
}

export async function maybeBackfill(
  force = false,
  opts: { retryFailed?: boolean } = {},
): Promise<void> {
  const state = currentSession();
  if (!state.pubkey) return;
  if (!state.signer || !get(canSign)) {
    clearQueuePoll();
    if (get(sessionRestoring)) return;
    if (session.hint?.kind === 'nip07' && await refreshBrowserExtensionSigner(state.pubkey)) {
      scheduleMaybe();
      return;
    }
    archiveBackfillStatus.set({
      state: 'paused',
      pubkey: state.pubkey,
      totalMissing: 0,
      queued: 0,
      skipped: 0,
      failed: 0,
      message: signerUnavailableMessage(),
      updatedAt: Date.now(),
    });
    return;
  }
  if (activeFor === state.pubkey) return;

  const settings = get(userSettings);
  const archiveByDefault = settings.archiveAllByDefault || !settings.archiveDefaultManualOverride;

  const bookmarks = get(ownBookmarks);
  if (bookmarks.length === 0) return;

  const lifetime = get(getLifetimeStatus(state.pubkey));
  if (!lifetime) return;

  const markerKey = LS_PREFIX + state.pubkey;
  const lastRun = Number(localStorage.getItem(markerKey) ?? '0');
  if (
    !force &&
    Number.isFinite(lastRun) &&
    Date.now() - lastRun < DAY_MS &&
    !hasRetryableMissingKeyArchives(state.pubkey)
  ) return;

  activeFor = state.pubkey;
  try {
    archiveBackfillStatus.set({
      state: 'checking',
      pubkey: state.pubkey,
      totalMissing: 0,
      queued: 0,
      skipped: 0,
      failed: 0,
      message: 'checking bookmarks against completed archives',
      updatedAt: Date.now(),
    });
    const fetchedArchives = await withTimeout(
      api.archives.listAll(),
      20_000,
      'archive check timed out',
    );
    const archiveHealth = await auditArchiveKeyHealth(fetchedArchives, state.pubkey);
    const archives = fetchedArchives;
    replaceMyArchiveRecords(state.pubkey, archives);
    const archivedUrls = new Set(archives.map((archive) => archive.url));
    const missingKeyUrls = new Set(archiveHealth.missing.map((archive) => archive.url));
    pruneQueuedArchiveUrls(state.pubkey, archivedUrls);
    const refreshed = await refreshQueuedArchiveStatuses(state.pubkey, archivedUrls, 150);
    const retryableFailed = releaseFailedArchiveQueueSlots(state.pubkey);
    const missingKeyRetry = await queueMissingKeyBackfill(
      archiveHealth.missing,
      state.pubkey,
      settings.backupBlossomServers,
      opts.retryFailed === true,
    );
    const mediaQueued = archiveByDefault ? await queueMediaBackfill(bookmarks, archives) : 0;
    const queueStatus = await loadArchiveQueueStatus();

    if (!archiveByDefault) {
      if (serverArchiveQueueCount(queueStatus) > 0) scheduleQueuePoll();
      else clearQueuePoll();
      archiveBackfillStatus.set({
        state: missingKeyRetry.queued > 0 ? 'queued' : 'paused',
        pubkey: state.pubkey,
        totalMissing: missingKeyRetry.queued + missingKeyRetry.skipped + missingKeyRetry.exhausted + missingKeyRetry.failed,
        queued: missingKeyRetry.queued,
        skipped: missingKeyRetry.skipped + missingKeyRetry.exhausted,
        failed: missingKeyRetry.failed,
        ...queueStatusFields(queueStatus),
        message: archiveCheckSummary(0, refreshed, retryableFailed, missingKeyRetry, mediaQueued, queueStatus) || 'archive-all setting is off',
        updatedAt: Date.now(),
      });
      if (mediaQueued > 0 || missingKeyRetry.queued > 0) {
        window.setTimeout(() => {
          void maybeBackfill(true);
        }, CONTINUE_DELAY_MS);
      }
      return;
    }

    let alreadyQueued = 0;
    const candidates = bookmarks
      .filter((bookmark) => {
        if (missingKeyUrls.has(bookmark.url)) return false;
        if (archivedUrls.has(bookmark.url)) return false;
        if (isArchiveQueuedRecently(state.pubkey!, bookmark.url)) {
          alreadyQueued += 1;
          return false;
        }
        if (bookmark.blossomHash || bookmark.waybackUrl) return false;
        try {
          const parsed = new URL(bookmark.url);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.savedAt - b.savedAt || a.url.localeCompare(b.url));

    if (candidates.length === 0) {
      if (serverArchiveQueueCount(queueStatus) > 0) scheduleQueuePoll();
      else clearQueuePoll();
      archiveBackfillStatus.set({
        state: alreadyQueued > 0 ? 'queued' : 'complete',
        pubkey: state.pubkey,
        totalMissing: alreadyQueued,
        queued: 0,
        skipped: alreadyQueued,
        failed: 0,
        ...queueStatusFields(queueStatus),
        message: archiveCheckSummary(alreadyQueued, refreshed, retryableFailed, missingKeyRetry, mediaQueued, queueStatus) || 'no missing archives found',
        updatedAt: Date.now(),
      });
      if (alreadyQueued === 0 && mediaQueued === 0 && missingKeyRetry.queued === 0) localStorage.setItem(markerKey, String(Date.now()));
      if (mediaQueued > 0 || missingKeyRetry.queued > 0) {
        window.setTimeout(() => {
          void maybeBackfill(true);
        }, CONTINUE_DELAY_MS);
      }
      return;
    }

    const serverOutstanding = serverArchiveQueueCount(queueStatus);
    if (serverOutstanding >= MAX_QUEUE_PER_RUN) {
      scheduleQueuePoll();
      archiveBackfillStatus.set({
        state: 'queued',
        pubkey: state.pubkey,
        totalMissing: candidates.length + alreadyQueued + serverOutstanding,
        queued: 0,
        skipped: alreadyQueued,
        failed: 0,
        ...queueStatusFields(queueStatus),
        message: `server queue already has ${serverOutstanding.toLocaleString()} archive job${serverOutstanding === 1 ? '' : 's'}; waiting for it to drain`,
        updatedAt: Date.now(),
      });
      return;
    }

    let failures = 0;
    let firstFailure = '';
    let queued = 0;
    let skipped = alreadyQueued;
    const slice = candidates.slice(0, MAX_QUEUE_PER_RUN);
    archiveBackfillStatus.set({
      state: 'queueing',
      pubkey: state.pubkey,
      totalMissing: candidates.length + alreadyQueued,
      queued,
      skipped,
      failed: failures,
      ...queueStatusFields(queueStatus),
      message: `queueing ${slice.length} of ${candidates.length} missing archives`,
      updatedAt: Date.now(),
    });
    for (const bookmark of slice) {
      const isPrivate = bookmark.eventId.startsWith('private:');
      try {
        const result = await enqueueArchivePage({
          url: bookmark.url,
          tier: isPrivate ? 'private' : 'public',
          pubkey: state.pubkey,
          eventId: isPrivate ? undefined : bookmark.eventId,
          bookmarkSavedAt: bookmark.savedAt,
          lifetime: true,
          mirrorUrls: settings.backupBlossomServers,
          dedupe: true,
        });
        if (result.jobId.startsWith('queued:')) skipped += 1;
        else queued += 1;
      } catch (error) {
        failures += 1;
        firstFailure ||= archiveQueueError(error);
      }
      archiveBackfillStatus.set({
        state: 'queueing',
        pubkey: state.pubkey,
        totalMissing: candidates.length + alreadyQueued,
        queued,
        skipped,
        failed: failures,
        ...queueStatusFields(queueStatus),
        message: failures > 0
          ? `queued ${queued} archive job${queued === 1 ? '' : 's'}; ${failures} failed — ${firstFailure}`
          : `queued ${queued} archive job${queued === 1 ? '' : 's'}`,
        updatedAt: Date.now(),
      });
    }
    const remaining = Math.max(0, candidates.length - slice.length);
    archiveBackfillStatus.set({
      state: failures > 0 ? 'error' : remaining > 0 ? 'queued' : 'complete',
      pubkey: state.pubkey,
      totalMissing: candidates.length + alreadyQueued,
      queued,
      skipped,
      failed: failures,
      ...queueStatusFields(queueStatus),
      message: failures > 0
        ? `${failures} archive queue failure${failures === 1 ? '' : 's'} — ${firstFailure}`
        : remaining > 0
          ? `queued ${queued}; ${remaining} still to check`
          : queued > 0
            ? `queued ${queued} archive job${queued === 1 ? '' : 's'}`
            : 'missing archives were already queued',
      updatedAt: Date.now(),
    });
    if (failures === 0 && remaining === 0 && mediaQueued === 0 && missingKeyRetry.queued === 0) localStorage.setItem(markerKey, String(Date.now()));
    if (failures === 0 && (remaining > 0 || mediaQueued > 0 || missingKeyRetry.queued > 0)) {
      window.setTimeout(() => {
        void maybeBackfill(true);
      }, CONTINUE_DELAY_MS);
    } else if (serverArchiveQueueCount(queueStatus) > 0) {
      scheduleQueuePoll();
    } else {
      clearQueuePoll();
    }
  } catch (error) {
    clearQueuePoll();
    archiveBackfillStatus.set({
      state: 'error',
      pubkey: state.pubkey,
      totalMissing: 0,
      queued: 0,
      skipped: 0,
      failed: 1,
      message: `couldn't check archives — ${error instanceof Error ? error.message : String(error)}`,
      updatedAt: Date.now(),
    });
  } finally {
    if (activeFor === state.pubkey) activeFor = null;
  }
}

function scheduleQueuePoll(): void {
  if (queuePollTimer) return;
  queuePollTimer = window.setTimeout(() => {
    queuePollTimer = null;
    void maybeBackfill(true);
  }, QUEUE_POLL_DELAY_MS);
}

function clearQueuePoll(): void {
  if (!queuePollTimer) return;
  window.clearTimeout(queuePollTimer);
  queuePollTimer = null;
}

function archiveCheckSummary(
  alreadyQueued: number,
  refreshed: { checked: number; completed: number; failed: number },
  retryableFailed: number,
  missingKeyRetry: { queued: number; skipped: number; exhausted: number; failed: number },
  mediaQueued: number,
  queueStatus: ArchiveQueueStatus | null,
): string {
  const parts: string[] = [];
  const serverQueued = serverArchiveQueueCount(queueStatus);
  if (serverQueued > 0) parts.push(`${serverQueued.toLocaleString()} queued/running on server`);
  if (alreadyQueued > 0) parts.push(`${alreadyQueued} archive job${alreadyQueued === 1 ? '' : 's'} already queued`);
  if (refreshed.checked > 0) parts.push(`checked ${refreshed.checked} queued job${refreshed.checked === 1 ? '' : 's'}`);
  if (refreshed.completed > 0) parts.push(`${refreshed.completed} completed`);
  if (refreshed.failed > 0) parts.push(`${refreshed.failed} failed`);
  if (retryableFailed > 0) parts.push(`${retryableFailed} failed archive${retryableFailed === 1 ? '' : 's'} ready to retry`);
  if (missingKeyRetry.queued > 0) parts.push(`${missingKeyRetry.queued} missing-key archive retr${missingKeyRetry.queued === 1 ? 'y' : 'ies'} queued`);
  if (missingKeyRetry.skipped > 0) parts.push(`${missingKeyRetry.skipped} missing-key archive${missingKeyRetry.skipped === 1 ? '' : 's'} waiting before retry`);
  if (missingKeyRetry.exhausted > 0) parts.push(`${missingKeyRetry.exhausted} missing-key archive${missingKeyRetry.exhausted === 1 ? '' : 's'} paused after repeated retries`);
  if (missingKeyRetry.failed > 0) parts.push(`${missingKeyRetry.failed} missing-key retr${missingKeyRetry.failed === 1 ? 'y' : 'ies'} failed to queue`);
  if (mediaQueued > 0) parts.push(`${mediaQueued} media archive${mediaQueued === 1 ? '' : 's'} queued`);
  return parts.join(' · ');
}

async function queueMissingKeyBackfill(
  missing: readonly ArchiveRecord[],
  pubkey: string,
  mirrorUrls: string[],
  force: boolean,
): Promise<{ queued: number; skipped: number; exhausted: number; failed: number }> {
  if (missing.length === 0) return { queued: 0, skipped: 0, exhausted: 0, failed: 0 };
  // Media records get the media pipeline (fresh key + media job); they
  // used to be excluded entirely, so a media archive with a lost key
  // vanished with no replacement and no signal.
  const retry = missingKeyRetryCandidates(pubkey, [...missing], { force });
  let queued = 0;
  let failed = 0;
  for (const rec of retry.candidates.filter((candidate) => isMediaArchiveRecord(candidate))) {
    try {
      const { requeueMediaArchiveWithFreshKey } = await import('$lib/media-archive');
      if (await requeueMediaArchiveWithFreshKey({
        url: rec.url,
        pubkey,
        bookmarkSavedAt: rec.bookmarkSavedAt ?? rec.archivedAt,
      })) {
        queued += 1;
        recordMissingKeyArchiveRetryQueued(pubkey, rec, `media:${rec.jobId}`);
      }
    } catch {
      failed += 1;
    }
  }
  for (const rec of retry.candidates.filter((candidate) => !isMediaArchiveRecord(candidate))) {
    try {
      const result = await enqueueArchivePage({
        url: rec.url,
        tier: 'private',
        pubkey,
        bookmarkSavedAt: rec.bookmarkSavedAt ?? rec.archivedAt,
        lifetime: true,
        mirrorUrls,
        dedupe: false,
      });
      if (result.jobId.startsWith('queued:')) continue;
      queued += 1;
      recordMissingKeyArchiveRetryQueued(pubkey, rec, result.jobId);
    } catch {
      failed += 1;
    }
  }
  return {
    queued,
    skipped: retry.skipped,
    exhausted: retry.exhausted,
    failed,
  };
}

function isMediaArchiveRecord(rec: ArchiveRecord): boolean {
  const kind = (rec.kind ?? '').toLowerCase();
  const contentType = (rec.contentType ?? '').toLowerCase();
  return kind === 'youtube' ||
    kind === 'video' ||
    kind === 'media' ||
    !!rec.videoId ||
    !!rec.videoContentKey ||
    contentType.startsWith('video/') ||
    contentType.startsWith('audio/') ||
    contentType.startsWith('image/') ||
    (rec.files ?? []).some((file) => file.role === 'media');
}

async function queueMediaBackfill(
  bookmarks: readonly ParsedBookmark[],
  archives: readonly ArchiveRecord[],
): Promise<number> {
  try {
    const result = await queueEligibleMediaArchives(bookmarks, archives);
    return result.queued;
  } catch {
    return 0;
  }
}

async function loadArchiveQueueStatus(): Promise<ArchiveQueueStatus | null> {
  try {
    return await withTimeout(
      api.archives.queueStatus(),
      10_000,
      'archive queue check timed out',
    );
  } catch {
    return null;
  }
}

function serverArchiveQueueCount(status: ArchiveQueueStatus | null): number {
  return status ? status.pending + status.running : 0;
}

function queueStatusFields(status: ArchiveQueueStatus | null): Partial<LifetimeArchiveBackfillStatus> {
  return status
    ? {
        serverPending: status.pending,
        serverRunning: status.running,
        serverArchivedTotal: status.archivedTotal,
      }
    : {};
}

function archiveQueueError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  const jsonStart = message.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as { error?: unknown; retryAfter?: unknown };
      if (typeof parsed.error === 'string') {
        return typeof parsed.retryAfter === 'number'
          ? `${parsed.error}; retry after ${parsed.retryAfter}s`
          : parsed.error;
      }
    } catch {
      // Fall through to the original message.
    }
  }
  return message;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      window.setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

function signerUnavailableMessage(): string {
  const kind = session.hint?.kind;
  if (kind === 'nip07') return 'unlock your browser extension to queue private archives';
  if (kind === 'nip46') return 'reconnect your remote signer to queue private archives';
  if (kind === 'android') return 'reconnect your Android signer to queue private archives';
  if (kind === 'nsec') return 'unlock your recovery-key session to queue private archives';
  return 'sign in with a signer to queue private archives';
}
