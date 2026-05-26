import {
  getMediaArchiveAddonStatus,
  startMediaArchive,
} from './archive.js';
import { scheduleArchiveKeyReconcileSoon } from './archive-key-reconciler.js';
import { generateArchiveKey, stashPendingKey } from './archive-keys.js';

const QUEUED_PREFIX = 'deepmarks-media-archive-queued:v1:';

const MEDIA_HOST_PATTERNS = [
  /(^|\.)youtube\.com$/i,
  /^youtu\.be$/i,
  /(^|\.)vimeo\.com$/i,
  /(^|\.)rumble\.com$/i,
  /(^|\.)odysee\.com$/i,
  /(^|\.)lbry\.tv$/i,
  /(^|\.)twitch\.tv$/i,
  /(^|\.)tiktok\.com$/i,
  /(^|\.)instagram\.com$/i,
];

const AUDIO_FILE_RE = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(?:$|[?#])/i;
const VIDEO_FILE_RE = /\.(mp4|m4v|mov|webm|mkv)(?:$|[?#])/i;

export function isPotentialMediaUrl(raw: string): boolean {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (AUDIO_FILE_RE.test(parsed.pathname) || VIDEO_FILE_RE.test(parsed.pathname)) return true;
  return MEDIA_HOST_PATTERNS.some((re) => re.test(parsed.hostname));
}

export async function maybeStartMediaArchiveForBookmark(input: {
  url: string;
  nsecHex: string;
  eventId?: string;
  bookmarkSavedAt?: number;
}): Promise<boolean> {
  if (!isPotentialMediaUrl(input.url) || await isQueued(input.url)) return false;
  const status = await getMediaArchiveAddonStatus(input.nsecHex);
  if (!status.purchased) return false;
  await markQueued(input.url);
  try {
    const archiveKey = generateArchiveKey();
    const result = await startMediaArchive({
      url: input.url,
      archiveKey,
      eventId: input.eventId,
      bookmarkSavedAt: input.bookmarkSavedAt,
    }, input.nsecHex);
    await stashPendingKey(result.jobId, archiveKey);
    scheduleArchiveKeyReconcileSoon();
    return true;
  } catch (err) {
    await clearQueued(input.url);
    throw err;
  }
}

async function isQueued(url: string): Promise<boolean> {
  const key = queueKey(url);
  const raw = await chrome.storage.local.get(key);
  const value = raw[key] as { queuedAt?: number } | undefined;
  const queuedAt = typeof value?.queuedAt === 'number' ? value.queuedAt : 0;
  if (queuedAt > Date.now() - 7 * 24 * 60 * 60 * 1000) return true;
  if (value) await chrome.storage.local.remove(key);
  return false;
}

async function markQueued(url: string): Promise<void> {
  await chrome.storage.local.set({ [queueKey(url)]: { queuedAt: Date.now() } });
}

async function clearQueued(url: string): Promise<void> {
  await chrome.storage.local.remove(queueKey(url));
}

function queueKey(url: string): string {
  return `${QUEUED_PREFIX}${url}`;
}
