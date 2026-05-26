// Friends-only bridge from ordinary Nostr notes to Deepmarks rows.
//
// Deepmarks remains a bookmark app: global/public feeds only read
// kind:39701 bookmarks. The friends page can additionally surface http(s)
// links that selected friends posted inside kind:1 notes, but we strip all
// surrounding social text and render only one link row per URL.

import { readable, type Readable } from 'svelte/store';
import {
  NDKEvent,
  NDKSubscriptionCacheUsage,
  type NDKFilter,
  type NDKKind,
  type NDKSubscription,
} from '@nostr-dev-kit/ndk';
import { getNdk } from './ndk.js';
import { KIND } from './kinds.js';
import {
  compareBookmarksNewest,
  type ParsedBookmark,
  type SignedEventLike,
} from './bookmarks.js';
import { mutedPubkeys } from './mute-list.js';
import { readableHost } from '../metadata/link-preview.js';

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;

export interface NostrNoteLinkBookmark extends ParsedBookmark {
  source: 'nostr-note-link';
  sourceEventId: string;
  sourceEventKind: typeof KIND.note;
}

interface Entry {
  bookmark: NostrNoteLinkBookmark;
  key: string;
}

export interface SocialLinkFeedOptions {
  authors: string[];
  limit?: number;
}

function dedupKey(pubkey: string, url: string): string {
  return `${pubkey}::${url}`;
}

export function extractHttpUrls(content: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of content.matchAll(URL_PATTERN)) {
    const cleaned = cleanUrlCandidate(match[0] ?? '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }
  return urls;
}

export function socialLinkBookmarksFromNote(event: SignedEventLike): NostrNoteLinkBookmark[] {
  if (event.kind !== KIND.note) return [];
  return extractHttpUrls(event.content).map((url, index) => ({
    url,
    title: titleFromUrl(url),
    description: '',
    tags: [],
    archivedForever: false,
    savedAt: event.created_at,
    eventCreatedAt: event.created_at,
    curator: event.pubkey,
    eventId: `note-link:${event.id}:${index}`,
    source: 'nostr-note-link',
    sourceEventId: event.id,
    sourceEventKind: KIND.note,
  }));
}

export function createSocialLinkFeed(opts: SocialLinkFeedOptions): Readable<NostrNoteLinkBookmark[]> {
  return readable<NostrNoteLinkBookmark[]>([], (set) => {
    const authors = opts.authors
      .map((author) => author.toLowerCase())
      .filter((author) => /^[0-9a-f]{64}$/.test(author));
    if (authors.length === 0) {
      set([]);
      return () => {};
    }

    const ndk = getNdk();
    const byKey = new Map<string, Entry>();
    let mutedSnapshot = new Set<string>();
    const unsubMutes = mutedPubkeys.subscribe((next) => {
      mutedSnapshot = next;
      emit();
    });

    const filter: NDKFilter = {
      kinds: [KIND.note as unknown as NDKKind, KIND.deletion as unknown as NDKKind],
      authors,
      limit: opts.limit ?? 500,
    };

    let sub: NDKSubscription | null = null;
    try {
      sub = ndk.subscribe(filter, {
        closeOnEose: false,
        cacheUsage: NDKSubscriptionCacheUsage.PARALLEL,
      });
      sub.on('event', (event: NDKEvent) => {
        const signed = event as unknown as SignedEventLike;
        if (signed.kind === KIND.deletion) {
          if (applyNoteDeletion(byKey, signed)) emit();
          return;
        }

        const bookmarks = socialLinkBookmarksFromNote(signed);
        let changed = false;
        for (const bookmark of bookmarks) {
          const key = dedupKey(bookmark.curator, bookmark.url);
          const existing = byKey.get(key);
          if (existing && !shouldReplaceSocial(existing.bookmark, bookmark)) continue;
          byKey.set(key, { bookmark, key });
          changed = true;
        }
        if (changed) emit();
      });
    } catch (e) {
      console.warn('Social link subscription failed:', e);
    }

    function emit(): void {
      const rows = Array.from(byKey.values())
        .map((entry) => entry.bookmark)
        .filter((bookmark) => !mutedSnapshot.has(bookmark.curator));
      rows.sort(compareBookmarksNewest);
      set(rows);
    }

    return () => {
      sub?.stop();
      unsubMutes();
    };
  });
}

function cleanUrlCandidate(raw: string): string | null {
  let candidate = raw.trim();
  while (candidate && /[.,!?;:)\]}>"']$/.test(candidate)) {
    candidate = candidate.slice(0, -1);
  }
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = readableHost(parsed);
    const pathname = parsed.pathname.toLowerCase();
    if (/\.(avif|gif|jpe?g|png|svg|webp)$/.test(pathname)) return `image from ${host}`;
    if (/\.(m4v|mov|mp4|mpeg|mpg|webm)$/.test(pathname)) return `video from ${host}`;
    if (/\.(aac|flac|m4a|mp3|ogg|opus|wav)$/.test(pathname)) return `audio from ${host}`;
    if (/\.pdf$/.test(pathname)) return `pdf from ${host}`;
    return host;
  } catch {
    return url;
  }
}

function shouldReplaceSocial(existing: NostrNoteLinkBookmark, incoming: NostrNoteLinkBookmark): boolean {
  if (incoming.savedAt > existing.savedAt) return true;
  if (incoming.savedAt < existing.savedAt) return false;
  return incoming.sourceEventId > existing.sourceEventId;
}

function applyNoteDeletion(byKey: Map<string, Entry>, deletion: SignedEventLike): boolean {
  const targets = new Set(
    deletion.tags
      .filter((tag) => tag[0] === 'e' && typeof tag[1] === 'string')
      .map((tag) => tag[1]),
  );
  if (targets.size === 0) return false;

  let changed = false;
  for (const [key, entry] of byKey) {
    if (
      entry.bookmark.curator === deletion.pubkey &&
      targets.has(entry.bookmark.sourceEventId) &&
      deletion.created_at >= entry.bookmark.savedAt
    ) {
      byKey.delete(key);
      changed = true;
    }
  }
  return changed;
}
