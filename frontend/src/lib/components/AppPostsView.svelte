<script lang="ts">
  import { derived, writable, type Readable } from 'svelte/store';
  import AppSectionNav from './AppSectionNav.svelte';
  import NoteCard from './NoteCard.svelte';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import { api, type PublicBookmark } from '$lib/api/client';
  import {
    createImportedBookmarksFeed,
    createImportedNoteRefsFeed,
    type ImportedNoteRef,
    type ImportedUrlBookmark,
  } from '$lib/nostr/imported-bookmarks';
  import { extractNostrEventIdFromUrl } from '$lib/nostr/social-refs';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { session, canSign } from '$lib/stores/session';
  import { KIND } from '$lib/nostr/kinds';

  type SavedNoteRef = ImportedNoteRef | {
    targetEventId: string;
    curator: string;
    savedAt: number;
    listEventId: string;
    listKind: number;
    listIdentifier: string;
    source: 'deepmarks-bookmark' | 'nip51-list-url';
  };

  type PostEntry = { kind: 'note'; data: SavedNoteRef };

  const PAGE_SIZE = 50;
  let visibleLimit = PAGE_SIZE;
  let paginationPubkey = '';
  let invalidNoteIds = new Set<string>();

  const serverPublicBookmarks = writable<ParsedBookmark[]>([]);
  let serverPublicLoadedFor: string | null = null;

  $: bookmarkFeed = $session.pubkey
    ? createBookmarkFeed({ authors: [$session.pubkey], limit: 200 })
    : null;

  $: if ($session.pubkey && $session.pubkey !== serverPublicLoadedFor) {
    serverPublicLoadedFor = $session.pubkey;
    serverPublicBookmarks.set([]);
    void loadServerPublicBookmarks($session.pubkey);
  } else if (!$session.pubkey && serverPublicLoadedFor !== null) {
    serverPublicLoadedFor = null;
    serverPublicBookmarks.set([]);
  }

  async function loadServerPublicBookmarks(pubkey: string) {
    try {
      const res = await api.publicBookmarks(pubkey, 200);
      serverPublicBookmarks.set(res.bookmarks.map(publicBookmarkToParsed));
    } catch {
      // The relay feed still backs this view; server cache is only a speed path.
    }
  }

  function publicBookmarkToParsed(bookmark: PublicBookmark): ParsedBookmark {
    return {
      url: bookmark.url,
      title: bookmark.title || bookmark.url,
      description: bookmark.description,
      tags: bookmark.tags,
      publishedAt: bookmark.publishedAt,
      blossomHash: bookmark.blossomHash,
      waybackUrl: bookmark.waybackUrl,
      archivedForever: bookmark.archivedForever,
      savedAt: bookmark.savedAt,
      eventCreatedAt: bookmark.eventCreatedAt,
      curator: bookmark.pubkey,
      eventId: bookmark.id,
    };
  }

  function setLatestPublic(byUrl: Map<string, ParsedBookmark>, bookmark: ParsedBookmark) {
    const existing = byUrl.get(bookmark.url);
    if (existing && existing.publishedAt === undefined && bookmark.savedAt < existing.savedAt) {
      byUrl.set(bookmark.url, {
        ...existing,
        publishedAt: bookmark.publishedAt,
        savedAt: bookmark.savedAt,
        savedAtMs: bookmark.savedAtMs,
      });
      return;
    }
    const bookmarkReplaceTime = bookmark.eventCreatedAt ?? bookmark.savedAt;
    const existingReplaceTime = existing ? (existing.eventCreatedAt ?? existing.savedAt) : -1;
    if (!existing || bookmarkReplaceTime > existingReplaceTime || (
      bookmarkReplaceTime === existingReplaceTime && bookmark.eventId > existing.eventId
    )) {
      byUrl.set(bookmark.url, mergePublicReplacement(existing, bookmark));
    }
  }

  function mergePublicReplacement(
    existing: ParsedBookmark | undefined,
    incoming: ParsedBookmark,
  ): ParsedBookmark {
    if (existing && incoming.publishedAt === undefined && existing.savedAt < incoming.savedAt) {
      return {
        ...incoming,
        publishedAt: existing.publishedAt,
        savedAt: existing.savedAt,
        savedAtMs: existing.savedAtMs,
      };
    }
    return incoming;
  }

  const PRIVATE_LS_PREFIX = 'deepmarks-private-bookmarks:v3:';
  function lsLoadPrivate(pubkey: string): ParsedBookmark[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(PRIVATE_LS_PREFIX + pubkey);
      return raw ? (JSON.parse(raw) as ParsedBookmark[]) : [];
    } catch { return []; }
  }
  function lsSavePrivate(pubkey: string, list: ParsedBookmark[]): void {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(PRIVATE_LS_PREFIX + pubkey, JSON.stringify(list)); }
    catch { /* quota */ }
  }

  const privateBookmarks = writable<ParsedBookmark[]>([]);
  let lastFetchedPrivatePubkey: string | null = null;
  $: if ($session.pubkey && $session.pubkey !== lastFetchedPrivatePubkey) {
    privateBookmarks.set(lsLoadPrivate($session.pubkey));
  }
  $: if ($session.pubkey && $canSign && $session.pubkey !== lastFetchedPrivatePubkey) {
    lastFetchedPrivatePubkey = $session.pubkey;
    void loadPrivate($session.pubkey);
  }
  async function loadPrivate(pubkey: string) {
    try {
      const { fetchOwnPrivateSet, parsePrivateEntry } = await import('$lib/nostr/private-bookmarks');
      const set = await fetchOwnPrivateSet(pubkey);
      const parsed: ParsedBookmark[] = [];
      const savedAt = Math.floor(Date.now() / 1000);
      for (const entry of set.entries) {
        const p = parsePrivateEntry(entry, pubkey, savedAt, '');
        if (p) parsed.push(p);
      }
      if (parsed.length > 0) {
        privateBookmarks.set(parsed);
        lsSavePrivate(pubkey, parsed);
      }
    } catch {
      /* keep cache */
    }
  }

  $: deepmarksSocialEntries = derived(
    [serverPublicBookmarks, bookmarkFeed ?? derived([], () => [] as ParsedBookmark[]), privateBookmarks],
    ([$serverPub, $pub, $priv]) => {
      const byUrl = new Map<string, ParsedBookmark>();
      for (const b of $serverPub) setLatestPublic(byUrl, b);
      for (const b of $pub) setLatestPublic(byUrl, b);
      for (const b of $priv) byUrl.set(b.url, b);
      return [...byUrl.values()]
        .map(bookmarkToNoteRef)
        .filter((entry): entry is PostEntry => entry !== null);
    },
  ) as Readable<PostEntry[]>;

  function bookmarkToNoteRef(bookmark: ParsedBookmark | ImportedUrlBookmark): PostEntry | null {
    const targetEventId = extractNostrEventIdFromUrl(bookmark.url);
    if (!targetEventId) return null;
    const imported = 'source' in bookmark && bookmark.source === 'nip51-list';
    return {
      kind: 'note',
      data: {
        targetEventId,
        curator: bookmark.curator,
        savedAt: bookmark.savedAt,
        listEventId: bookmark.eventId,
        listKind: imported ? bookmark.listKind : KIND.webBookmark,
        listIdentifier: imported ? bookmark.listIdentifier : bookmark.url,
        source: imported ? 'nip51-list-url' : 'deepmarks-bookmark',
      },
    };
  }

  $: postUrls = $session.pubkey
    ? createImportedBookmarksFeed({ authors: [$session.pubkey], limit: 200 })
    : null;

  $: postNotes = $session.pubkey
    ? createImportedNoteRefsFeed({ authors: [$session.pubkey], limit: 200 })
    : null;

  $: postsEntries = derived(
    [
      postUrls ?? derived([], () => [] as ImportedUrlBookmark[]),
      postNotes ?? derived([], () => [] as ImportedNoteRef[]),
      deepmarksSocialEntries,
    ],
    ([$urls, $notes, $social]) => {
      const byKey = new Map<string, PostEntry>();
      for (const url of $urls) {
        const noteRef = bookmarkToNoteRef(url);
        if (noteRef) absorb(byKey, noteRef);
      }
      for (const note of $notes) absorb(byKey, { kind: 'note', data: note });
      for (const entry of $social) absorb(byKey, entry);
      return [...byKey.values()].sort((a, b) => b.data.savedAt - a.data.savedAt);
    },
  ) as Readable<PostEntry[]>;

  function absorb(byKey: Map<string, PostEntry>, entry: PostEntry): void {
    const key = `note:${entry.data.targetEventId}`;
    const existing = byKey.get(key);
    if (!existing || entry.data.savedAt > existing.data.savedAt) {
      byKey.set(key, entry);
    }
  }

  function handleInvalidNote(event: CustomEvent<{ targetEventId: string }>): void {
    const targetEventId = event.detail.targetEventId;
    if (invalidNoteIds.has(targetEventId)) return;
    invalidNoteIds = new Set(invalidNoteIds).add(targetEventId);
  }

  $: if (($session.pubkey ?? '') !== paginationPubkey) {
    paginationPubkey = $session.pubkey ?? '';
    visibleLimit = PAGE_SIZE;
    invalidNoteIds = new Set();
  }
  $: displayEntries = $postsEntries.filter((entry) => !invalidNoteIds.has(entry.data.targetEventId));
  $: if (visibleLimit > Math.max(PAGE_SIZE, displayEntries.length)) {
    visibleLimit = Math.max(PAGE_SIZE, displayEntries.length);
  }
  $: visibleEntries = displayEntries.slice(0, visibleLimit);
  $: hasMore = visibleLimit < displayEntries.length;
</script>

<svelte:head><title>your posts — Deepmarks</title></svelte:head>

<AppSectionNav active="posts" postsCount={displayEntries.length} />

<div class="posts-stream">
  {#if displayEntries.length === 0}
    <p class="empty">
      no Nostr social bookmarks yet — posts you bookmark in Damus / Primal, or Nostr note URLs you save in Deepmarks, appear here.
    </p>
  {:else}
    {#each visibleEntries as entry (`n:${entry.data.listEventId}:${entry.data.targetEventId}`)}
      <NoteCard targetEventId={entry.data.targetEventId} on:invalid={handleInvalidNote} />
    {/each}
    {#if hasMore}
      <div class="load-more-wrap">
        <button type="button" class="load-more" on:click={() => { visibleLimit = Math.min(visibleLimit + PAGE_SIZE, displayEntries.length); }}>
          load more
        </button>
        <span>showing {Math.min(visibleLimit, displayEntries.length).toLocaleString()} of {displayEntries.length.toLocaleString()}</span>
      </div>
    {/if}
  {/if}
</div>

<style>
  .posts-stream {
    max-width: 820px;
    margin: 0 auto;
    padding: 18px 24px 60px;
  }
  .empty {
    color: var(--muted);
    font-size: 13px;
    padding: 16px 0;
  }
  .load-more-wrap {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 12px;
    margin: 18px 0 8px;
    color: var(--muted);
    font-size: 12px;
  }
  .load-more {
    border: 1px solid var(--rule);
    background: var(--surface);
    color: var(--link);
    border-radius: 999px;
    padding: 8px 14px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .load-more:hover {
    border-color: var(--coral);
    color: var(--coral-deep);
  }
  @media (max-width: 720px) {
    .load-more-wrap {
      flex-direction: column;
      gap: 8px;
    }
  }
</style>
