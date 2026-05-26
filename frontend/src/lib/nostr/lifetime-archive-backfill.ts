import { get, writable, type Unsubscriber } from 'svelte/store';
import { browser } from '$app/environment';
import { api, type ArchiveQueueStatus } from '$lib/api/client';
import {
  enqueueArchivePage,
  isArchiveQueuedRecently,
  pruneQueuedArchiveUrls,
  refreshQueuedArchiveStatuses,
} from '$lib/nostr/archive';
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

export async function maybeBackfill(force = false): Promise<void> {
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
  if (!archiveByDefault) {
    clearQueuePoll();
    archiveBackfillStatus.set({
      state: 'paused',
      pubkey: state.pubkey,
      totalMissing: 0,
      queued: 0,
      skipped: 0,
      failed: 0,
      message: 'archive-all setting is off',
      updatedAt: Date.now(),
    });
    return;
  }

  const bookmarks = get(ownBookmarks);
  if (bookmarks.length === 0) return;

  const lifetime = get(getLifetimeStatus(state.pubkey));
  if (!lifetime) return;

  const markerKey = LS_PREFIX + state.pubkey;
  const lastRun = Number(localStorage.getItem(markerKey) ?? '0');
  if (!force && Number.isFinite(lastRun) && Date.now() - lastRun < DAY_MS) return;

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
    const archives = await withTimeout(
      api.archives.listAll(),
      20_000,
      'archive check timed out',
    );
    replaceMyArchiveRecords(state.pubkey, archives);
    const archivedUrls = new Set(archives.map((archive) => archive.url));
    pruneQueuedArchiveUrls(state.pubkey, archivedUrls);
    const refreshed = await refreshQueuedArchiveStatuses(state.pubkey, archivedUrls, 150);
    const queueStatus = await loadArchiveQueueStatus();
    let alreadyQueued = 0;
    const candidates = bookmarks
      .filter((bookmark) => {
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
        message: archiveCheckSummary(alreadyQueued, refreshed, queueStatus) || 'no missing archives found',
        updatedAt: Date.now(),
      });
      if (alreadyQueued === 0) localStorage.setItem(markerKey, String(Date.now()));
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
    if (failures === 0 && remaining === 0) localStorage.setItem(markerKey, String(Date.now()));
    if (failures === 0 && remaining > 0) {
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
  queueStatus: ArchiveQueueStatus | null,
): string {
  const parts: string[] = [];
  const serverQueued = serverArchiveQueueCount(queueStatus);
  if (serverQueued > 0) parts.push(`${serverQueued.toLocaleString()} queued/running on server`);
  if (alreadyQueued > 0) parts.push(`${alreadyQueued} archive job${alreadyQueued === 1 ? '' : 's'} already queued`);
  if (refreshed.checked > 0) parts.push(`checked ${refreshed.checked} queued job${refreshed.checked === 1 ? '' : 's'}`);
  if (refreshed.completed > 0) parts.push(`${refreshed.completed} completed`);
  if (refreshed.failed > 0) parts.push(`${refreshed.failed} failed`);
  return parts.join(' · ');
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
  if (kind === 'nsec') return 'unlock your recovery-key session to queue private archives';
  return 'sign in with a signer to queue private archives';
}
