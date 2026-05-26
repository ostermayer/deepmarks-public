<script lang="ts">
  import { writable, type Readable } from 'svelte/store';
  import { page } from '$app/stores';
  import AppSectionNav from './AppSectionNav.svelte';
  import Subheader from '$lib/components/Subheader.svelte';
  import AppActionBar from '$lib/components/AppActionBar.svelte';
  import SaveBox from '$lib/components/SaveBox.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import {
    compareBookmarksNewest,
    compareBookmarksOldest,
    type ParsedBookmark
  } from '$lib/nostr/bookmarks';
  import { ownBookmarks, rememberOwnBookmark } from '$lib/stores/own-bookmarks';
  import {
    createImportedBookmarksFeed,
    createImportedNoteRefsFeed,
    type ImportedNoteRef,
    type ImportedUrlBookmark,
  } from '$lib/nostr/imported-bookmarks';
  import { extractNostrEventIdFromUrl } from '$lib/nostr/social-refs';
  import { myArchives } from '$lib/stores/my-archives';
  import { session } from '$lib/stores/session';
  import { friendPubkeys } from '$lib/nostr/friends';
  import { archiveQueueRevision, archiveQueueStats } from '$lib/nostr/archive';
  import { archiveBackfillStatus, maybeBackfill } from '$lib/nostr/lifetime-archive-backfill';
  import { isPotentialMediaUrl } from '$lib/media-archive';
  import { isNativeShell } from '$lib/native/runtime';
  import { searchLocalBookmarks } from '$lib/search/local-bookmark-search';
  import SharePinOnboarding from './SharePinOnboarding.svelte';

  const bookmarks = ownBookmarks;
  const nativeShell = isNativeShell();
  let queuedUrls = new Set<string>();
  let failedUrls = new Set<string>();
  let unknownQueuedUrls = new Set<string>();
  const emptyImportedUrls = writable<ImportedUrlBookmark[]>([]);
  const emptyImportedNotes = writable<ImportedNoteRef[]>([]);
  let postUrls: Readable<ImportedUrlBookmark[]> = emptyImportedUrls;
  let postNotes: Readable<ImportedNoteRef[]> = emptyImportedNotes;
  let addOpen = false;
  let searchOpen = false;
  let searchQuery = '';
  let searchAllMine = false;

  function handleSaved(event: CustomEvent<{ bookmark: ParsedBookmark; isPublic: boolean }>) {
    const { bookmark, isPublic } = event.detail;
    rememberOwnBookmark(bookmark, isPublic);
  }

  // Sort is now ORDERING only — newest/oldest/title-az/title-za.
  // The "what set am I looking at" tab (all bookmarks / read later /
  // archives) is driven by the URL query param and surfaced via the
  // section nav tabs, not the sort row. This keeps the sort row
  // short enough to stay on one line on phone widths.
  type Sort = 'newest' | 'oldest' | 'title-az' | 'title-za';
  type View = 'all' | 'archived' | 'readlater' | 'media';
  const sort = writable<Sort>('newest');
  $: view = ((): View => {
    const v = $page.url.searchParams.get('view');
    if (v === 'archived') return 'archived';
    if (v === 'readlater') return 'readlater';
    if (v === 'media') return 'media';
    return 'all';
  })();

  $: postUrls = $session.pubkey
    ? createImportedBookmarksFeed({ authors: [$session.pubkey], limit: 200 })
    : emptyImportedUrls;

  $: postNotes = $session.pubkey
    ? createImportedNoteRefsFeed({ authors: [$session.pubkey], limit: 200 })
    : emptyImportedNotes;

  function setSort(id: string): void {
    sort.set(id as Sort);
  }

  function onSearchScope(event: CustomEvent<{ id: string; checked: boolean }>): void {
    if (event.detail.id === 'all-mine') searchAllMine = event.detail.checked;
  }

  function titleFor(bookmark: ParsedBookmark): string {
    return (bookmark.title || bookmark.url).toLocaleLowerCase();
  }

  $: {
    $archiveQueueRevision;
    const stats = $session.pubkey
      ? archiveQueueStats($session.pubkey)
      : { queuedUrls: new Set<string>(), failedUrls: new Set<string>(), unknownUrls: new Set<string>() };
    queuedUrls = stats.queuedUrls;
    failedUrls = stats.failedUrls;
    unknownQueuedUrls = stats.unknownUrls;
  }

  function hasCompletedArchive(bookmark: ParsedBookmark): boolean {
    return !!bookmark.blossomHash || !!bookmark.waybackUrl || $myArchives.has(bookmark.url);
  }

  function hasArchiveWorkflow(bookmark: ParsedBookmark): boolean {
    return bookmark.archivedForever ||
      hasCompletedArchive(bookmark) ||
      queuedUrls.has(bookmark.url) ||
      failedUrls.has(bookmark.url) ||
      unknownQueuedUrls.has(bookmark.url);
  }

  function filterBookmarks(list: ParsedBookmark[], currentView: View): ParsedBookmark[] {
    if (currentView === 'archived') return list.filter((b) => hasArchiveWorkflow(b));
    if (currentView === 'readlater') return list.filter((b) => b.tags.includes('toread'));
    if (currentView === 'media') return list.filter((b) => isPotentialMediaUrl(b.url));
    return list;
  }

  function sortBookmarks(list: ParsedBookmark[], currentSort: Sort): ParsedBookmark[] {
    const sorted = [...list];
    switch (currentSort) {
      case 'newest':
        sorted.sort(compareBookmarksNewest);
        break;
      case 'oldest':
        sorted.sort(compareBookmarksOldest);
        break;
      case 'title-az':
        sorted.sort((a, b) => titleFor(a).localeCompare(titleFor(b)));
        break;
      case 'title-za':
        sorted.sort((a, b) => titleFor(b).localeCompare(titleFor(a)));
        break;
    }
    return sorted;
  }

  function countPostBookmarks(
    list: ParsedBookmark[],
    importedUrls: ImportedUrlBookmark[],
    importedNotes: ImportedNoteRef[],
  ): number {
    const ids = new Set<string>();
    for (const bookmark of list) {
      const id = extractNostrEventIdFromUrl(bookmark.url);
      if (id) ids.add(id);
    }
    for (const bookmark of importedUrls) {
      const id = extractNostrEventIdFromUrl(bookmark.url);
      if (id) ids.add(id);
    }
    for (const note of importedNotes) ids.add(note.targetEventId);
    return ids.size;
  }

  $: visibleBaseBookmarks = filterBookmarks($bookmarks, view);
  $: activeSearchQuery = searchOpen ? searchQuery.trim() : '';
  $: searchSource = activeSearchQuery && searchAllMine ? $bookmarks : visibleBaseBookmarks;
  $: searchedBookmarks = activeSearchQuery
    ? searchLocalBookmarks(searchSource, activeSearchQuery, { limit: 10_000 })
    : visibleBaseBookmarks;
  $: sortedBookmarks = sortBookmarks(searchedBookmarks, $sort);
  $: searchScopeOptions = view === 'all'
    ? []
    : [{ id: 'all-mine', label: 'search all my bookmarks', checked: searchAllMine }];
  $: searchSummary = activeSearchQuery
    ? `${sortedBookmarks.length.toLocaleString()} ${sortedBookmarks.length === 1 ? 'match' : 'matches'}`
    : '';
  $: paginationKey = `${$sort}:${view}:${activeSearchQuery}:${searchAllMine ? 'all' : 'view'}`;
  $: postsCount = countPostBookmarks($bookmarks, $postUrls, $postNotes);
  $: readLaterCount = $bookmarks.filter((b) => b.tags.includes('toread')).length;
  $: mediaBookmarkCount = $bookmarks.filter((b) => isPotentialMediaUrl(b.url)).length;
  $: archivedWorkflowBookmarks = $bookmarks.filter((b) => hasArchiveWorkflow(b));
  $: completedArchiveCount = archivedWorkflowBookmarks.filter((b) => hasCompletedArchive(b)).length;
  $: queuedArchiveCount = archivedWorkflowBookmarks.filter((b) => !hasCompletedArchive(b) && queuedUrls.has(b.url)).length;
  $: previousQueueCount = archivedWorkflowBookmarks.filter((b) => !hasCompletedArchive(b) && unknownQueuedUrls.has(b.url)).length;
  $: failedArchiveCount = archivedWorkflowBookmarks.filter((b) => !hasCompletedArchive(b) && failedUrls.has(b.url)).length;
  $: waitingArchiveCount = archivedWorkflowBookmarks.filter((b) => !hasCompletedArchive(b) && !queuedUrls.has(b.url) && !unknownQueuedUrls.has(b.url) && !failedUrls.has(b.url)).length;
  $: currentArchiveStatus = $archiveBackfillStatus.pubkey === $session.pubkey ? $archiveBackfillStatus : null;
  $: serverQueueCount = currentArchiveStatus
    ? (currentArchiveStatus.serverPending ?? 0) + (currentArchiveStatus.serverRunning ?? 0)
    : 0;
</script>

<svelte:head><title>your bookmarks — Deepmarks</title></svelte:head>

<AppSectionNav
  active={
    view === 'readlater' ? 'readlater'
    : view === 'archived' ? 'archives'
    : 'bookmarks'
  }
  bookmarksCount={$bookmarks.length}
  friendsCount={$friendPubkeys.size}
  {postsCount}
  {readLaterCount}
  archivesCount={completedArchiveCount}
/>

<Subheader
  sorts={[
    { label: 'newest',    id: 'newest',   current: $sort === 'newest' },
    { label: 'oldest',    id: 'oldest',   current: $sort === 'oldest' },
    { label: 'title a-z', id: 'title-az', current: $sort === 'title-az' },
    { label: 'title z-a', id: 'title-za', current: $sort === 'title-za' },
  ]}
  onSort={setSort}
/>

<AppActionBar
  bind:addOpen
  bind:searchOpen
  bind:searchQuery
  searchPlaceholder={
    view === 'readlater' ? 'search read later...'
    : view === 'archived' ? 'search archived bookmarks...'
    : view === 'media' ? 'search media bookmarks...'
    : 'search your bookmarks...'
  }
  searchScopes={searchScopeOptions}
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
  on:scope={onSearchScope}
/>

{#if view === 'archived'}
  <section class="archive-progress" aria-live="polite">
    <div>
      <strong>{completedArchiveCount.toLocaleString()} archived</strong>
      <span>
        {#if serverQueueCount > 0}
          {serverQueueCount.toLocaleString()} queued/running on server
        {:else}
          {queuedArchiveCount.toLocaleString()} queued/running
        {/if}
        {#if previousQueueCount > 0}
          · {previousQueueCount.toLocaleString()} queued by older app version
        {/if}
        {#if failedArchiveCount > 0}
          · {failedArchiveCount.toLocaleString()} failed
        {/if}
        {#if waitingArchiveCount > 0}
          · {waitingArchiveCount.toLocaleString()} waiting to queue
        {/if}
      </span>
      {#if $archiveBackfillStatus.pubkey === $session.pubkey && $archiveBackfillStatus.message}
        <small>{$archiveBackfillStatus.message}</small>
      {/if}
    </div>
    <button type="button" on:click={() => void maybeBackfill(true)}>
      check archives
    </button>
  </section>
{/if}
<BookmarkList
  bookmarks={sortedBookmarks}
  summaryBookmarks={$bookmarks}
  archivedCountOverride={completedArchiveCount}
  mediaCountOverride={mediaBookmarkCount}
  paginationKey={paginationKey}
  loading={true}
  showStats={true}
  freezeFeed={false}
  emptyMessage={
    activeSearchQuery ? `no matches for "${activeSearchQuery}"`
    : view === 'archived' ? 'no archived bookmarks yet — toggle "archive" on save'
    : view === 'readlater' ? 'nothing saved for later yet — toggle "read later" on save'
    : view === 'media' ? 'no media bookmarks yet — save a video or audio page'
    : 'no bookmarks yet — paste a URL to save your first'
  }
>
  <svelte:fragment slot="prepend">
    <SharePinOnboarding />
    {#if addOpen && !nativeShell}
      <SaveBox on:saved={handleSaved} />
    {/if}
  </svelte:fragment>
</BookmarkList>

<style>
  .archive-progress {
    max-width: 980px;
    margin: 0 24px 12px;
    padding: 10px 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    border: 1px solid var(--rule);
    border-left: 4px solid var(--archive);
    background: var(--surface);
    color: var(--ink);
    font-size: 13px;
  }
  .archive-progress div {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .archive-progress strong {
    color: var(--ink-deep);
    font-family: 'Space Grotesk', Inter, sans-serif;
  }
  .archive-progress span,
  .archive-progress small {
    color: var(--muted);
  }
  .archive-progress button {
    flex: 0 0 auto;
    border: 1px solid var(--rule);
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-size: 12px;
    padding: 6px 10px;
    border-radius: 8px;
    cursor: pointer;
  }
  .archive-progress button:hover {
    border-color: var(--coral);
    color: var(--coral-deep);
  }
  @media (max-width: 720px) {
    .archive-progress {
      margin: 0 20px 12px;
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
