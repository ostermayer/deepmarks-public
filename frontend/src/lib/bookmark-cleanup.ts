import type { ArchiveRecord } from '$lib/api/client.js';
import type { ParsedBookmark } from '$lib/nostr/bookmarks.js';

export type CleanupReason =
  | 'duplicate-canonical-url'
  | 'archive-failed';

export interface BookmarkCleanupCandidate {
  id: string;
  bookmark: ParsedBookmark;
  canonicalUrl: string;
  reasons: CleanupReason[];
  reasonLabels: string[];
  details: string[];
  selectedByDefault: boolean;
}

export interface BookmarkCleanupAudit {
  candidates: BookmarkCleanupCandidate[];
  duplicateGroups: number;
  failedArchives: number;
  missingArchives: number;
  missingArchiveBookmarks: ParsedBookmark[];
  recommendedDeletes: number;
}

export interface BookmarkCleanupAuditInput {
  bookmarks: readonly ParsedBookmark[];
  archiveRecords?: readonly ArchiveRecord[];
  archivedUrlKeys?: ReadonlySet<string>;
  failedArchiveUrls?: ReadonlySet<string>;
  queuedArchiveUrls?: ReadonlySet<string>;
  archiveByDefault?: boolean;
}

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'mc_cid',
  'mc_eid',
  'igshid',
]);

export function canonicalCleanupUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    for (const key of [...url.searchParams.keys()]) {
      const normalized = key.toLowerCase();
      if (normalized.startsWith('utm_') || TRACKING_PARAMS.has(normalized)) {
        url.searchParams.delete(key);
      }
    }
    const sorted = [...url.searchParams.entries()].sort(([aKey, aVal], [bKey, bVal]) => (
      aKey.localeCompare(bKey) || aVal.localeCompare(bVal)
    ));
    url.search = '';
    for (const [key, value] of sorted) url.searchParams.append(key, value);
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return rawUrl.trim();
  }
}

export function buildBookmarkCleanupAudit(input: BookmarkCleanupAuditInput): BookmarkCleanupAudit {
  const byId = new Map<string, BookmarkCleanupCandidate>();
  const archivedKeys = new Set(input.archivedUrlKeys ?? archiveRecordKeys(input.archiveRecords ?? []));
  const queued = input.queuedArchiveUrls ?? new Set<string>();
  const failed = input.failedArchiveUrls ?? new Set<string>();

  const byCanonical = new Map<string, ParsedBookmark[]>();
  for (const bookmark of input.bookmarks) {
    const canonical = canonicalCleanupUrl(bookmark.url);
    const group = byCanonical.get(canonical) ?? [];
    group.push(bookmark);
    byCanonical.set(canonical, group);
  }

  let duplicateGroups = 0;
  for (const [canonicalUrl, group] of byCanonical.entries()) {
    if (group.length <= 1) continue;
    duplicateGroups += 1;
    const sorted = [...group].sort(compareCleanupKeepPreference);
    for (const duplicate of sorted.slice(1)) {
      upsertCandidate(byId, duplicate, canonicalUrl, 'duplicate-canonical-url', true, [
        'duplicate URL',
        `same canonical URL as ${sorted[0]?.title || sorted[0]?.url || canonicalUrl}`,
      ]);
    }
  }

  for (const bookmark of input.bookmarks) {
    const canonicalUrl = canonicalCleanupUrl(bookmark.url);
    if (failed.has(bookmark.url) || failed.has(canonicalUrl)) {
      upsertCandidate(byId, bookmark, canonicalUrl, 'archive-failed', true, [
        'archive failed',
        'archive worker could not produce a snapshot',
      ]);
      continue;
    }

  }

  const missingArchiveBookmarks = input.archiveByDefault
    ? input.bookmarks.filter((bookmark) => {
      const canonicalUrl = canonicalCleanupUrl(bookmark.url);
      if (byId.has(cleanupCandidateId(bookmark))) return false;
      if (failed.has(bookmark.url) || failed.has(canonicalUrl)) return false;
      if (bookmark.archivedForever || bookmark.blossomHash || bookmark.waybackUrl) return false;
      if (hasArchiveForUrl(bookmark.url, archivedKeys)) return false;
      if (queued.has(bookmark.url) || queued.has(canonicalUrl)) return false;
      return isArchiveableUrl(bookmark.url);
    })
    : [];

  const candidates = [...byId.values()].sort((a, b) => (
    Number(b.selectedByDefault) - Number(a.selectedByDefault) ||
    b.reasons.length - a.reasons.length ||
    b.bookmark.savedAt - a.bookmark.savedAt ||
    a.bookmark.url.localeCompare(b.bookmark.url)
  ));

  return {
    candidates,
    duplicateGroups,
    failedArchives: candidates.filter((candidate) => candidate.reasons.includes('archive-failed')).length,
    missingArchives: missingArchiveBookmarks.length,
    missingArchiveBookmarks,
    recommendedDeletes: candidates.filter((candidate) => candidate.selectedByDefault).length,
  };
}

function upsertCandidate(
  map: Map<string, BookmarkCleanupCandidate>,
  bookmark: ParsedBookmark,
  canonicalUrl: string,
  reason: CleanupReason,
  selectedByDefault: boolean,
  [label, detail]: [string, string],
): void {
  const id = cleanupCandidateId(bookmark);
  const existing = map.get(id);
  if (existing) {
    if (!existing.reasons.includes(reason)) {
      existing.reasons.push(reason);
      existing.reasonLabels.push(label);
      existing.details.push(detail);
    }
    existing.selectedByDefault ||= selectedByDefault;
    return;
  }
  map.set(id, {
    id,
    bookmark,
    canonicalUrl,
    reasons: [reason],
    reasonLabels: [label],
    details: [detail],
    selectedByDefault,
  });
}

export function cleanupCandidateId(bookmark: Pick<ParsedBookmark, 'url' | 'eventId'>): string {
  return `${bookmark.eventId}:${bookmark.url}`;
}

function compareCleanupKeepPreference(a: ParsedBookmark, b: ParsedBookmark): number {
  const archivePreference = Number(isArchivedBookmark(b)) - Number(isArchivedBookmark(a));
  if (archivePreference !== 0) return archivePreference;
  const savedAt = b.savedAt - a.savedAt;
  if (savedAt !== 0) return savedAt;
  return b.eventId.localeCompare(a.eventId);
}

function isArchivedBookmark(bookmark: ParsedBookmark): boolean {
  return bookmark.archivedForever || !!bookmark.blossomHash || !!bookmark.waybackUrl;
}

function archiveRecordKeys(records: readonly ArchiveRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const record of records) {
    keys.add(record.url);
    keys.add(canonicalCleanupUrl(record.url));
  }
  return keys;
}

function hasArchiveForUrl(url: string, archivedKeys: ReadonlySet<string>): boolean {
  if (archivedKeys.has(url)) return true;
  return archivedKeys.has(canonicalCleanupUrl(url));
}

function isArchiveableUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
