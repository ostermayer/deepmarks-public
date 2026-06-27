<script lang="ts">
  import { onDestroy } from 'svelte';
  import { derived, get, writable, type Readable } from 'svelte/store';
  import AppSectionNav from './AppSectionNav.svelte';
  import AppActionBar from './AppActionBar.svelte';
  import Subheader from './Subheader.svelte';
  import SaveBox from '$lib/components/SaveBox.svelte';
  import Overlay from '$lib/components/Overlay.svelte';
  import ToolbarActions from '$lib/components/ToolbarActions.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import BookmarkCard from '$lib/components/BookmarkCard.svelte';
  import PostCard from './PostCard.svelte';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import { api, type PublicBookmark } from '$lib/api/client';
  import {
    createImportedBookmarksFeed,
    createImportedNoteRefsFeed,
    isImportedUrlBookmark,
    type ImportedNoteRef,
    type ImportedUrlBookmark,
  } from '$lib/nostr/imported-bookmarks';
  import { extractNostrEventIdFromUrl, nostrNoteArchiveUrl } from '$lib/nostr/social-refs';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { session, canSign } from '$lib/stores/session';
  import { userSettings } from '$lib/stores/user-settings';
  import { ownBookmarks, rememberOwnBookmark } from '$lib/stores/own-bookmarks';
  import { myArchives } from '$lib/stores/my-archives';
  import { friendPubkeys } from '$lib/nostr/friends';
  import { enqueueArchivePage } from '$lib/nostr/archive';
  import { getLifetimeStatus } from '$lib/nostr/lifetime-status';
  import { KIND } from '$lib/nostr/kinds';
  import { tallyReceiptsInWindow, type ZapAggregate } from '$lib/nostr/popularity';
  import {
    createTargetedZapReceiptFeed,
    type ZapReceiptRecord,
  } from '$lib/nostr/zap-counts';
  import { searchLocalBookmarks } from '$lib/search/local-bookmark-search';
  import { resolveEvent } from '$lib/nostr/event-resolver';
  import { isNativeShell } from '$lib/native/runtime';
  import { isPotentialMediaUrl } from '$lib/media-archive';
  import { maybePrefetchPrivateNip51NoteTargets } from '$lib/nostr/social-bookmark-prefetch';

  type SavedNoteRef = ImportedNoteRef | {
    targetEventId: string;
    curator: string;
    savedAt: number;
    listEventId: string;
    listKind: number;
    listIdentifier: string;
    source: 'deepmarks-bookmark' | 'nip51-list-url';
    archiveTier?: 'public' | 'private';
  };

  type PostEntry = { kind: 'note'; data: SavedNoteRef };
  type PostSort = 'newest' | 'zap-sats' | 'oldest';

  const PAGE_SIZE = 50;
  const emptyImportedUrls = writable<ImportedUrlBookmark[]>([]);
  const emptyImportedNotes = writable<ImportedNoteRef[]>([]);
  const emptyZapReceipts = writable<ZapReceiptRecord[]>([]);
  let visibleLimit = PAGE_SIZE;
  let paginationPubkey = '';
  let postSort: PostSort = 'newest';
  let invalidNoteIds = new Set<string>();
  let postArchiveInFlight = false;
  let queuedPostArchiveUrls = new Set<string>();
  let addOpen = false;
  let searchOpen = false;
  let searchQuery = '';
  let searchAllMine = false;
  let postSearchRevision = 0;
  let postSearchSubscriptionKey = '';
  let postSearchUnsubs: Array<() => void> = [];
  let lastPostSearchSignature = '';
  let targetedZapReceipts: Readable<ZapReceiptRecord[]> = emptyZapReceipts;
  let zapTargetSignature = '';
  const nativeShell = isNativeShell();

  const serverPublicBookmarks = writable<ParsedBookmark[]>([]);
  let serverPublicLoadedFor: string | null = null;

  function handleSaved(event: CustomEvent<{ bookmark: ParsedBookmark; isPublic: boolean }>) {
    const { bookmark, isPublic } = event.detail;
    rememberOwnBookmark(bookmark, isPublic);
  }

  function onSearchScope(event: CustomEvent<{ id: string; checked: boolean }>): void {
    if (event.detail.id === 'all-mine') searchAllMine = event.detail.checked;
  }

  $: bookmarkFeed = $session.pubkey
    ? createBookmarkFeed({ authors: [$session.pubkey], limit: 200 })
    : null;
  $: lifetimeStatus = $session.pubkey ? getLifetimeStatus($session.pubkey) : null;
  $: isLifetime = !!(lifetimeStatus && $lifetimeStatus === true);

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
      const now = Math.floor(Date.now() / 1000);
      const existingByUrl = new Map(get(privateBookmarks).map((bookmark) => [bookmark.url, bookmark.savedAt]));
      for (const entry of set.entries) {
        const url = entry.find((t) => t[0] === 'd')?.[1];
        const fallback = url ? (existingByUrl.get(url) ?? now) : now;
        const p = parsePrivateEntry(entry, pubkey, fallback, '');
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
        .map((bookmark) => bookmarkToNoteRef(bookmark, $priv.some((privateBookmark) => privateBookmark.url === bookmark.url)))
        .filter((entry): entry is PostEntry => entry !== null);
    },
  ) as Readable<PostEntry[]>;

  function bookmarkToNoteRef(
    bookmark: ParsedBookmark | ImportedUrlBookmark,
    isPrivate = false,
  ): PostEntry | null {
    const targetEventId = extractNostrEventIdFromUrl(bookmark.url);
    if (!targetEventId) return null;
    const imported = isImportedUrlBookmark(bookmark);
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
        archiveTier: isPrivate || (imported && bookmark.visibility === 'private') ? 'private' : 'public',
      },
    };
  }

  $: postUrls = $session.pubkey
    ? createImportedBookmarksFeed({ authors: [$session.pubkey], limit: 200, decryptPrivate: $canSign })
    : emptyImportedUrls;

  $: postNotes = $session.pubkey
    ? createImportedNoteRefsFeed({ authors: [$session.pubkey], limit: 500, decryptPrivate: $canSign })
    : emptyImportedNotes;
  $: maybePrefetchPrivateNip51NoteTargets($session.pubkey, $postNotes ?? []);

  $: postsEntries = derived(
    [
      postUrls,
      postNotes,
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
      return [...byKey.values()].sort(comparePostEntriesNewest);
    },
  ) as Readable<PostEntry[]>;

  function absorb(byKey: Map<string, PostEntry>, entry: PostEntry): void {
    const key = `note:${entry.data.targetEventId}`;
    const existing = byKey.get(key);
    if (!existing || comparePostEntriesNewest(entry, existing) < 0) {
      byKey.set(key, entry);
    }
  }

  function comparePostEntriesNewest(a: PostEntry, b: PostEntry): number {
    const time = b.data.savedAt - a.data.savedAt;
    if (time !== 0) return time;
    const list = b.data.listEventId.localeCompare(a.data.listEventId);
    if (list !== 0) return list;
    return a.data.targetEventId.localeCompare(b.data.targetEventId);
  }

  function comparePostEntriesOldest(a: PostEntry, b: PostEntry): number {
    return comparePostEntriesNewest(b, a);
  }

  function postZapSats(entry: PostEntry, zapDataByEventId: Map<string, ZapAggregate>): number {
    return Math.floor((zapDataByEventId.get(entry.data.targetEventId)?.totalMsat ?? 0) / 1000);
  }

  function sortPostEntries(
    entries: PostEntry[],
    currentSort: PostSort,
    zapDataByEventId: Map<string, ZapAggregate>,
  ): PostEntry[] {
    const out = entries.slice();
    if (currentSort === 'zap-sats') {
      out.sort((a, b) => {
        const sats = postZapSats(b, zapDataByEventId) - postZapSats(a, zapDataByEventId);
        if (sats !== 0) return sats;
        return comparePostEntriesNewest(a, b);
      });
      return out;
    }
    if (currentSort === 'oldest') out.sort(comparePostEntriesOldest);
    else out.sort(comparePostEntriesNewest);
    return out;
  }

  function setPostSort(id: string): void {
    postSort = id as PostSort;
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
    queuedPostArchiveUrls = new Set();
  }
  $: nextZapTargetIds = [...new Set($postsEntries.map((entry) => entry.data.targetEventId).filter(Boolean))].sort();
  $: nextZapTargetSignature = nextZapTargetIds.join(',');
  $: if (nextZapTargetSignature !== zapTargetSignature) {
    zapTargetSignature = nextZapTargetSignature;
    targetedZapReceipts = nextZapTargetIds.length > 0
      ? createTargetedZapReceiptFeed({ targetEventIds: nextZapTargetIds })
      : emptyZapReceipts;
  }
  $: zapSatsByEventId = tallyReceiptsInWindow($targetedZapReceipts, 0);
  $: displayEntries = sortPostEntries(
    $postsEntries.filter((entry) => !invalidNoteIds.has(entry.data.targetEventId)),
    postSort,
    zapSatsByEventId,
  );
  $: void maybeQueuePostArchives(displayEntries, $session.pubkey, isLifetime);
  // Map each bookmarked note to the user's own Deepmarks bookmark for it
  // (if they've saved/tagged it), keyed by the note's event id so it works
  // regardless of which URL form the bookmark was saved under. PostCard
  // uses this to edit tags/read-later/archive in place vs. adopt-on-action.
  $: ownByNoteId = (() => {
    const map = new Map<string, ParsedBookmark>();
    for (const b of $ownBookmarks) {
      const id = extractNostrEventIdFromUrl(b.url);
      if (id && !map.has(id)) map.set(id, b);
    }
    return map;
  })();
  $: activeSearchQuery = searchOpen ? searchQuery.trim() : '';
  $: postSearchSignature = `${activeSearchQuery}:${searchAllMine ? 'all' : 'posts'}:${postSort}`;
  $: if (postSearchSignature !== lastPostSearchSignature) {
    visibleLimit = PAGE_SIZE;
    lastPostSearchSignature = postSearchSignature;
  }
  $: syncPostSearchSubscriptions(displayEntries, activeSearchQuery);
  $: postSearchRevision;
  $: searchedPostEntries = activeSearchQuery
    ? displayEntries.filter((entry) => postMatches(entry, activeSearchQuery))
    : displayEntries;
  $: searchedBookmarkResults = activeSearchQuery && searchAllMine
    ? searchLocalBookmarks($ownBookmarks, activeSearchQuery, { limit: 200 })
    : [];
  $: resultCount = searchedPostEntries.length + searchedBookmarkResults.length;
  $: searchSummary = activeSearchQuery
    ? `${resultCount.toLocaleString()} ${resultCount === 1 ? 'match' : 'matches'}`
    : '';
  $: if (visibleLimit > Math.max(PAGE_SIZE, searchedPostEntries.length)) {
    visibleLimit = Math.max(PAGE_SIZE, searchedPostEntries.length);
  }
  $: visibleEntries = searchedPostEntries.slice(0, visibleLimit);
  $: hasMore = visibleLimit < searchedPostEntries.length;
  $: completedArchiveCount = $ownBookmarks.filter((bookmark) =>
    bookmark.blossomHash || bookmark.waybackUrl || $myArchives.has(bookmark.url),
  ).length;
  $: mediaBookmarkCount = $ownBookmarks.filter((bookmark) => isPotentialMediaUrl(bookmark.url)).length;

  onDestroy(() => {
    clearPostSearchSubscriptions();
  });

  function clearPostSearchSubscriptions(): void {
    for (const unsubscribe of postSearchUnsubs) unsubscribe();
    postSearchUnsubs = [];
    postSearchSubscriptionKey = '';
  }

  function syncPostSearchSubscriptions(entries: PostEntry[], query: string): void {
    const ids = query ? entries.slice(0, 300).map((entry) => entry.data.targetEventId) : [];
    const key = ids.join(',');
    if (key === postSearchSubscriptionKey) return;
    clearPostSearchSubscriptions();
    postSearchSubscriptionKey = key;
    if (!query) return;
    postSearchUnsubs = ids.map((id) => resolveEvent(id).subscribe(() => {
      postSearchRevision += 1;
    }));
  }

  function postMatches(entry: PostEntry, rawQuery: string): boolean {
    const event = get(resolveEvent(entry.data.targetEventId));
    const haystack = [
      entry.data.targetEventId,
      entry.data.listEventId,
      event?.content ?? '',
      event?.pubkey ?? '',
    ].join('\n').toLowerCase();
    return rawQuery.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
  }

  async function maybeQueuePostArchives(
    entries: PostEntry[],
    pubkey: string | null,
    lifetime: boolean,
  ): Promise<void> {
    if (!pubkey || !lifetime || postArchiveInFlight) return;
    const archiveByDefault = $userSettings.archiveAllByDefault || !$userSettings.archiveDefaultManualOverride;
    if (!archiveByDefault) return;
    const candidates = entries
      .slice(0, 200)
      .map((entry) => ({
        entry,
        url: nostrNoteArchiveUrl(entry.data.targetEventId),
      }))
      .filter((candidate): candidate is { entry: PostEntry; url: string } =>
        !!candidate.url && !queuedPostArchiveUrls.has(candidate.url),
      );
    if (candidates.length === 0) return;

    postArchiveInFlight = true;
    try {
      for (const { entry, url } of candidates) {
        const tier = postArchiveTier(entry);
        queuedPostArchiveUrls = new Set(queuedPostArchiveUrls).add(url);
        await enqueueArchivePage({
          url,
          tier,
          pubkey,
          eventId: tier === 'private' ? undefined : entry.data.listEventId,
          bookmarkSavedAt: entry.data.savedAt,
          lifetime: true,
          mirrorUrls: $userSettings.backupBlossomServers,
          dedupe: true,
        }).catch(() => {
          // The archive queue is best-effort here; the bookmark list stays usable,
          // and failed queue slots can be retried from the Archives view.
        });
      }
    } finally {
      postArchiveInFlight = false;
    }
  }

  function postArchiveTier(entry: PostEntry): 'public' | 'private' {
    if ('visibility' in entry.data && entry.data.visibility === 'private') return 'private';
    return 'archiveTier' in entry.data && entry.data.archiveTier === 'private' ? 'private' : 'public';
  }
</script>

<svelte:head><title>your posts — Deepmarks</title></svelte:head>

<AppSectionNav active="posts" bookmarksCount={$ownBookmarks.length} friendsCount={$friendPubkeys.size} postsCount={displayEntries.length} />

<Subheader
  sorts={[
    { label: 'newest',  id: 'newest',   current: postSort === 'newest' },
    { label: 'oldest',  id: 'oldest',   current: postSort === 'oldest' },
    { label: '⚡ sats', id: 'zap-sats', current: postSort === 'zap-sats' },
  ]}
  onSort={setPostSort}
>
  <svelte:fragment slot="actions">
    <ToolbarActions
      {addOpen}
      {searchOpen}
      resultSummary={searchSummary}
      addDisabled={nativeShell}
      on:toggleAdd={() => {
        addOpen = !addOpen;
        if (addOpen) searchOpen = false;
      }}
      on:toggleSearch={() => {
        searchOpen = !searchOpen;
        if (searchOpen) addOpen = false;
      }}
    />
  </svelte:fragment>
</Subheader>

<AppActionBar
  bind:searchOpen
  bind:searchQuery
  panelOnly
  searchPlaceholder="search your saved Nostr posts..."
  searchScopes={[{ id: 'all-mine', label: 'include all my bookmarks', checked: searchAllMine }]}
  on:scope={onSearchScope}
/>

<BookmarkList
  bookmarks={$ownBookmarks}
  summaryBookmarks={$ownBookmarks}
  archivedCountOverride={completedArchiveCount}
  mediaCountOverride={mediaBookmarkCount}
  loading={false}
  showStats={true}
  freezeFeed={false}
  showPendingBanner={false}
  paginationKey={`posts:${postSort}:${activeSearchQuery}:${searchAllMine ? 'all' : 'posts'}`}
>
  <svelte:fragment slot="prepend">
    <Overlay
      open={addOpen && !nativeShell}
      ariaLabel="add a bookmark"
      on:close={() => (addOpen = false)}
    >
      <SaveBox on:saved={handleSaved} />
    </Overlay>
  </svelte:fragment>

  {#if activeSearchQuery && searchAllMine && searchedBookmarkResults.length > 0}
    <section class="bookmark-results" aria-label="bookmark matches">
      <div class="result-heading">
        <strong>bookmark matches</strong>
        <span>{searchedBookmarkResults.length.toLocaleString()}</span>
      </div>
      {#each searchedBookmarkResults as bookmark (bookmark.eventId)}
        <BookmarkCard {bookmark} />
      {/each}
    </section>
  {/if}

  {#if displayEntries.length === 0}
    <p class="empty">
      no Nostr social bookmarks yet — posts you bookmark in Damus / Primal, or Nostr note URLs you save in Deepmarks, appear here.
    </p>
  {:else if activeSearchQuery && resultCount === 0}
    <p class="empty">no matches for <code>{activeSearchQuery}</code></p>
  {:else}
    {#each visibleEntries as entry (`n:${entry.data.listEventId}:${entry.data.targetEventId}`)}
      <PostCard
        targetEventId={entry.data.targetEventId}
        savedAt={entry.data.savedAt}
        zapSats={postZapSats(entry, zapSatsByEventId)}
        originVisibility={postArchiveTier(entry)}
        ownBookmark={ownByNoteId.get(entry.data.targetEventId)}
        on:invalid={handleInvalidNote}
      />
    {/each}
    {#if hasMore}
      <div class="load-more-wrap">
        <button type="button" class="load-more" on:click={() => { visibleLimit = Math.min(visibleLimit + PAGE_SIZE, searchedPostEntries.length); }}>
          load more
        </button>
        <span>showing {Math.min(visibleLimit, searchedPostEntries.length).toLocaleString()} of {searchedPostEntries.length.toLocaleString()}</span>
      </div>
    {/if}
  {/if}
</BookmarkList>

<style>
  .empty {
    color: var(--muted);
    font-size: 13px;
    padding: 16px 0;
  }
  .bookmark-results {
    margin-bottom: 18px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--rule);
  }
  .result-heading {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 10px 0 6px;
    color: var(--ink-deep);
    font-size: 13px;
  }
  .result-heading span {
    color: var(--muted);
    font-size: 12px;
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
