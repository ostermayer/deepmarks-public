import { bookmarkSortScore, type BookmarkJson } from '../api-helpers.js';
import type { Event as NostrEvent } from 'nostr-tools';

export const FRIENDS_SET_NAME = 'deepmarks-friends';

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const HEX_64_RE = /^[0-9a-f]{64}$/i;

export function socialLinksToBookmarks(events: NostrEvent[]): BookmarkJson[] {
  const out: BookmarkJson[] = [];
  for (const event of events) {
    if (event.kind !== 1) continue;
    const seen = new Set<string>();
    let index = 0;
    for (const match of event.content.matchAll(URL_PATTERN)) {
      const url = cleanUrlCandidate(match[0] ?? '');
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({
        id: `note-link:${event.id}:${index}`,
        pubkey: event.pubkey,
        url,
        title: titleFromUrl(url),
        description: '',
        tags: [],
        archivedForever: false,
        savedAt: event.created_at,
        eventCreatedAt: event.created_at,
      });
      index += 1;
    }
  }
  return out;
}

export function friendPubkeysFromEvents(events: NostrEvent[]): string[] {
  const latest = events
    .filter((event) =>
      event.kind === 30000 &&
      event.tags.some((tag) => tag[0] === 'd' && tag[1] === FRIENDS_SET_NAME),
    )
    .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))[0];
  if (!latest) return [];
  return Array.from(new Set(
    latest.tags
      .filter((tag) => tag[0] === 'p' && typeof tag[1] === 'string' && HEX_64_RE.test(tag[1]))
      .map((tag) => tag[1].toLowerCase()),
  ));
}

export function mergeFriendsBookmarks(explicit: BookmarkJson[], social: BookmarkJson[]): BookmarkJson[] {
  const byKey = new Map<string, BookmarkJson>();
  for (const bookmark of social) byKey.set(`${bookmark.pubkey}::${bookmark.url}`, bookmark);
  for (const bookmark of explicit) byKey.set(`${bookmark.pubkey}::${bookmark.url}`, bookmark);
  return [...byKey.values()].sort((a, b) => bookmarkSortScore(b) - bookmarkSortScore(a));
}

function cleanUrlCandidate(raw: string): string | null {
  let candidate = raw.trim();
  while (candidate && /[.,!?;:)\]}>"']$/.test(candidate)) candidate = candidate.slice(0, -1);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function readableHost(url: URL): string {
  const labels = url.hostname.split('.').filter(Boolean);
  if (labels.length >= 3 && labels[0].length > 24) return labels.slice(-2).join('.');
  return url.hostname.replace(/^www\./, '');
}

function titleFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const host = readableHost(parsed);
    const pathname = parsed.pathname.toLowerCase();
    if (/\.(avif|gif|jpe?g|png|svg|webp)$/.test(pathname)) return `image from ${host}`;
    if (/\.(m4v|mov|mp4|mpeg|mpg|webm)$/.test(pathname)) return `video from ${host}`;
    if (/\.(aac|flac|m4a|mp3|ogg|opus|wav)$/.test(pathname)) return `audio from ${host}`;
    if (/\.pdf$/.test(pathname)) return `pdf from ${host}`;
    return host;
  } catch {
    return rawUrl;
  }
}
