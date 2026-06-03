import { nsecStore } from './nsec-store.js';
import { archiveStatus, getLifetimeStatus, listAllMyArchives, startLifetimeArchive } from './archive.js';
import { scheduleArchiveKeyReconcileSoon } from './archive-key-reconciler.js';
import { generateArchiveKey, publishPendingArchiveKey, stashPendingKey } from './archive-keys.js';
import { queueEligibleMediaArchiveBackfill } from './media-archive.js';
import { fetchPrivateBookmarks } from './private-bookmarks.js';
import { getSettings, type Settings } from './settings-store.js';

const ALARM_NAME = 'deepmarks-lifetime-archive-backfill';
const QUEUED_KEY_PREFIX = 'deepmarks-private-archive-backfill:v1:';
const LAST_EMPTY_PREFIX = 'deepmarks-private-archive-backfill-empty:v1:';
const QUEUED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMPTY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 250;

let running = false;
let installed = false;

export function startLifetimeArchiveBackfillService(): void {
  if (installed) return;
  installed = true;
  createAlarm({ periodInMinutes: 15 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void runLifetimeArchiveBackfill();
  });
  setTimeout(() => {
    void runLifetimeArchiveBackfill();
  }, 2_000);
}

export async function runLifetimeArchiveBackfill(force = false): Promise<void> {
  if (running) return;
  running = true;
  try {
    const account = await nsecStore.getState();
    if (!account.pubkey || !account.nsecHex || account.locked) return;

    const settings = await getSettings();
    if (!shouldArchiveByDefault(settings)) return;

    const lifetime = await getLifetimeStatus(account.pubkey).catch(() => null);
    if (!lifetime?.isLifetimeMember) return;

    if (!force) {
      const lastEmpty = await readLastEmpty(account.pubkey);
      if (lastEmpty && Date.now() - lastEmpty < EMPTY_TTL_MS) return;
    }

    const [archives, bookmarks] = await Promise.all([
      listAllMyArchives(account.nsecHex),
      fetchPrivateBookmarks(account.nsecHex, account.pubkey),
    ]);
    const archivedUrls = new Set(archives.map((archive) => archive.url));
    const queued = await refreshQueuedMap(account.pubkey, await readQueuedMap(account.pubkey), archivedUrls);
    const media = await queueEligibleMediaArchiveBackfill({
      bookmarks,
      archives,
      nsecHex: account.nsecHex,
      pubkey: account.pubkey,
    });
    const candidates = bookmarks
      .filter((bookmark) => {
        if (archivedUrls.has(bookmark.url)) return false;
        if (queued[bookmark.url] && Date.now() - queued[bookmark.url].queuedAt < QUEUED_TTL_MS) return false;
        try {
          const parsed = new URL(bookmark.url);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.savedAt - b.savedAt || a.url.localeCompare(b.url));

    if (candidates.length === 0) {
      if (media.queued === 0) await writeLastEmpty(account.pubkey, Date.now());
      else createAlarm({ delayInMinutes: 1, periodInMinutes: 15 });
      return;
    }

    const nextQueued = { ...queued };
    const slice = candidates.slice(0, MAX_PER_RUN);
    for (const bookmark of slice) {
      const archiveKey = generateArchiveKey();
      try {
        const result = await startLifetimeArchive(
          {
            url: bookmark.url,
            tier: 'private',
            archiveKey,
            mirrorUrls: settings.backupBlossomServers,
          },
          account.nsecHex,
        );
        await stashPendingKey(result.jobId, archiveKey).catch(() => undefined);
        await publishPendingArchiveKey(result.jobId, archiveKey, account.nsecHex, account.pubkey).catch(() => undefined);
        scheduleArchiveKeyReconcileSoon();
        nextQueued[bookmark.url] = { queuedAt: Date.now(), jobId: result.jobId };
        await writeQueuedMap(account.pubkey, nextQueued);
      } catch {
        // Leave unqueued so the next alarm can retry.
      }
    }

    if (candidates.length > slice.length || media.queued > 0) {
      createAlarm({ delayInMinutes: 1, periodInMinutes: 15 });
    }
  } finally {
    running = false;
  }
}

function createAlarm(info: chrome.alarms.AlarmCreateInfo): void {
  Promise.resolve(chrome.alarms.create(ALARM_NAME, info)).catch(() => undefined);
}

function shouldArchiveByDefault(settings: Settings): boolean {
  return settings.archiveDefault || !settings.archiveDefaultManualOverride;
}

interface QueuedEntry {
  queuedAt: number;
  jobId: string;
  state?: 'pending-payment' | 'queued' | 'archiving' | 'mirroring' | 'done' | 'failed';
  lastCheckedAt?: number;
  error?: string;
}

interface QueuedMap {
  [url: string]: QueuedEntry;
}

async function readQueuedMap(pubkey: string): Promise<QueuedMap> {
  const raw = await chrome.storage.local.get(QUEUED_KEY_PREFIX + pubkey);
  const value = raw[QUEUED_KEY_PREFIX + pubkey] as QueuedMap | undefined;
  if (!value || typeof value !== 'object') return {};
  const now = Date.now();
  const out: QueuedMap = {};
  for (const [url, entry] of Object.entries(value)) {
    if (!entry || typeof entry.queuedAt !== 'number' || typeof entry.jobId !== 'string') continue;
    if (now - entry.queuedAt < QUEUED_TTL_MS) out[url] = entry;
  }
  return out;
}

async function writeQueuedMap(pubkey: string, map: QueuedMap): Promise<void> {
  await chrome.storage.local.set({ [QUEUED_KEY_PREFIX + pubkey]: map });
}

async function refreshQueuedMap(
  pubkey: string,
  map: QueuedMap,
  completedUrls: Set<string>,
): Promise<QueuedMap> {
  const next: QueuedMap = { ...map };
  let changed = false;
  for (const url of completedUrls) {
    if (url in next) {
      delete next[url];
      changed = true;
    }
  }
  const candidates = Object.entries(next)
    .filter(([, entry]) => entry.state !== 'failed')
    .sort(([, a], [, b]) => (a.lastCheckedAt ?? 0) - (b.lastCheckedAt ?? 0))
    .slice(0, 150);
  await Promise.all(candidates.map(async ([url, entry]) => {
    try {
      const status = await archiveStatus(entry.jobId);
      const state = status.state ?? statusToState(status.status);
      if (state === 'done') {
        delete next[url];
      } else if (state === 'failed') {
        delete next[url];
      } else {
        next[url] = {
          ...entry,
          state,
          lastCheckedAt: Date.now(),
          error: undefined,
        };
      }
      changed = true;
    } catch (error) {
      if (error instanceof Error && /archive status 404/.test(error.message)) {
        delete next[url];
      } else {
        next[url] = {
          ...entry,
          lastCheckedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
      changed = true;
    }
  }));
  if (changed) await writeQueuedMap(pubkey, next);
  return next;
}

function statusToState(status: string | undefined): QueuedEntry['state'] {
  if (status === 'archived' || status === 'done') return 'done';
  if (status === 'enqueued' || status === 'queued') return 'queued';
  if (status === 'expired' || status === 'failed') return 'failed';
  if (status === 'archiving' || status === 'mirroring' || status === 'pending-payment') return status;
  return undefined;
}

async function readLastEmpty(pubkey: string): Promise<number> {
  const raw = await chrome.storage.local.get(LAST_EMPTY_PREFIX + pubkey);
  const value = raw[LAST_EMPTY_PREFIX + pubkey];
  return typeof value === 'number' ? value : 0;
}

async function writeLastEmpty(pubkey: string, value: number): Promise<void> {
  await chrome.storage.local.set({ [LAST_EMPTY_PREFIX + pubkey]: value });
}
