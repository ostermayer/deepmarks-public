import { get } from 'svelte/store';
import { api, type ArchiveRecord } from '$lib/api/client';
import { generateArchiveKey, stashPendingArchiveKey } from '$lib/nostr/archive-keys';
import type { ParsedBookmark } from '$lib/nostr/bookmarks';
import { session } from '$lib/stores/session';

const QUEUED_PREFIX = 'deepmarks-media-archive-queued:v1:';
const MAX_BACKLOG_ENQUEUE_PER_PASS = 12;

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

export interface MediaArchiveCounts {
  eligible: number;
  archived: number;
  queued: number;
}

export function isPotentialMediaUrl(raw: string): boolean {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (AUDIO_FILE_RE.test(parsed.pathname) || VIDEO_FILE_RE.test(parsed.pathname)) return true;
  return MEDIA_HOST_PATTERNS.some((re) => re.test(parsed.hostname));
}

export function isMediaArchiveRecord(record: ArchiveRecord | undefined): boolean {
  if (!record) return false;
  const kind = (record.kind ?? '').toLowerCase();
  if (kind === 'media' || kind === 'video' || kind === 'youtube') return true;
  return /^audio\//i.test(record.contentType ?? '') || /^video\//i.test(record.contentType ?? '');
}

export function mediaArchiveCounts(
  bookmarks: readonly ParsedBookmark[],
  archives: readonly ArchiveRecord[],
): MediaArchiveCounts {
  const eligibleUrls = new Set(bookmarks.map((b) => b.url).filter(isPotentialMediaUrl));
  const archivedUrls = new Set<string>();
  for (const record of archives) {
    if (eligibleUrls.has(record.url) && isMediaArchiveRecord(record)) archivedUrls.add(record.url);
  }
  let queued = 0;
  for (const url of eligibleUrls) if (isMediaQueued(url)) queued += 1;
  return {
    eligible: eligibleUrls.size,
    archived: archivedUrls.size,
    queued,
  };
}

export async function maybeQueueMediaArchiveForBookmark(input: {
  bookmark?: ParsedBookmark;
  url: string;
  pubkey?: string | null;
  eventId?: string;
  bookmarkSavedAt?: number;
}): Promise<boolean> {
  const pubkey = input.pubkey ?? get(session).pubkey;
  if (!pubkey || !isPotentialMediaUrl(input.url)) return false;
  if (isMediaQueued(input.url)) return false;
  const status = await api.mediaArchive.status();
  if (!status.purchased) return false;
  return queueOneMediaArchive({
    url: input.url,
    eventId: input.eventId ?? input.bookmark?.eventId,
    bookmarkSavedAt: input.bookmarkSavedAt ?? input.bookmark?.savedAt,
  });
}

export async function queueEligibleMediaArchives(
  bookmarks: readonly ParsedBookmark[],
  archives: readonly ArchiveRecord[],
): Promise<{ queued: number; skipped: number }> {
  const status = await api.mediaArchive.status();
  if (!status.purchased) return { queued: 0, skipped: 0 };

  const archived = new Set(
    archives
      .filter(isMediaArchiveRecord)
      .map((record) => record.url),
  );
  const byUrl = new Map<string, ParsedBookmark>();
  for (const bookmark of bookmarks) {
    if (!isPotentialMediaUrl(bookmark.url)) continue;
    if (!byUrl.has(bookmark.url)) byUrl.set(bookmark.url, bookmark);
  }

  let queued = 0;
  let skipped = 0;
  for (const bookmark of byUrl.values()) {
    if (queued >= MAX_BACKLOG_ENQUEUE_PER_PASS) break;
    if (archived.has(bookmark.url) || isMediaQueued(bookmark.url)) {
      skipped += 1;
      continue;
    }
    try {
      if (await queueOneMediaArchive({
        url: bookmark.url,
        eventId: bookmark.eventId,
        bookmarkSavedAt: bookmark.savedAt,
      })) queued += 1;
    } catch {
      skipped += 1;
    }
  }
  return { queued, skipped };
}

async function queueOneMediaArchive(input: {
  url: string;
  eventId?: string;
  bookmarkSavedAt?: number;
}): Promise<boolean> {
  markMediaQueued(input.url);
  try {
    const archiveKey = generateArchiveKey();
    const result = await api.mediaArchive.enqueue({
      url: input.url,
      archiveKey,
      eventId: input.eventId,
      bookmarkSavedAt: input.bookmarkSavedAt,
    });
    stashPendingArchiveKey(result.jobId, archiveKey);
    return true;
  } catch (err) {
    unmarkMediaQueued(input.url);
    throw err;
  }
}

function queueKey(url: string): string {
  return `${QUEUED_PREFIX}${url}`;
}

function isMediaQueued(url: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const raw = localStorage.getItem(queueKey(url));
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { queuedAt?: number };
    const queuedAt = typeof parsed.queuedAt === 'number' ? parsed.queuedAt : 0;
    if (queuedAt > Date.now() - 7 * 24 * 60 * 60 * 1000) return true;
    localStorage.removeItem(queueKey(url));
  } catch {
    return false;
  }
  return false;
}

function markMediaQueued(url: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(queueKey(url), JSON.stringify({ queuedAt: Date.now() }));
  } catch {
    // Non-fatal; server-side queue still owns truth after enqueue.
  }
}

function unmarkMediaQueued(url: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(queueKey(url));
  } catch {
    // Non-fatal.
  }
}
