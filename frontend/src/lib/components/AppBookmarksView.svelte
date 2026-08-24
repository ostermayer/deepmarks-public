<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { writable, type Readable } from 'svelte/store';
  import { page } from '$app/stores';
  import AppSectionNav from './AppSectionNav.svelte';
  import Subheader from '$lib/components/Subheader.svelte';
  import AppActionBar from '$lib/components/AppActionBar.svelte';
  import SaveBox from '$lib/components/SaveBox.svelte';
  import Overlay from '$lib/components/Overlay.svelte';
  import ToolbarActions from '$lib/components/ToolbarActions.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import {
    compareBookmarksNewest,
    compareBookmarksOldest,
    type ParsedBookmark
  } from '$lib/nostr/bookmarks';
  import {
    bookmarkZapTargetEventIds,
    sortBookmarksByZapSats,
  } from '$lib/nostr/bookmark-zap-target';
  import { tallyReceiptsInWindow, type ZapAggregate } from '$lib/nostr/popularity';
  import {
    createTargetedZapReceiptFeed,
    type ZapReceiptRecord,
  } from '$lib/nostr/zap-counts';
  import { ownBookmarks, privateDecryptIssue, refreshOwnBookmarks, rememberOwnBookmark } from '$lib/stores/own-bookmarks';
  import { pendingPublishes, refreshPendingPublishCount } from '$lib/nostr/pending-publish';
  import {
    createImportedBookmarksFeed,
    createImportedNoteRefsFeed,
    type ImportedNoteRef,
    type ImportedUrlBookmark,
  } from '$lib/nostr/imported-bookmarks';
  import { extractNostrEventIdFromUrl, nostrNoteArchiveUrl } from '$lib/nostr/social-refs';
  import { myArchives } from '$lib/stores/my-archives';
  import { canSign, session } from '$lib/stores/session';
  import { friendPubkeys } from '$lib/nostr/friends';
  import { archiveQueueRevision, archiveQueueStats } from '$lib/nostr/archive';
  import { archiveBackfillStatus, maybeBackfill, retryFailedArchives } from '$lib/nostr/lifetime-archive-backfill';
  import {
    missingKeyArchiveUrls,
  } from '$lib/archives/key-health';
  import { isPotentialMediaUrl } from '$lib/media-archive';
  import { isNativeShell } from '$lib/native/runtime';
  import { searchLocalBookmarks } from '$lib/search/local-bookmark-search';
  import { bookmarkToSearchResult, OVERLAY_RESULT_CAP } from '$lib/search/search-result';
  import SharePinOnboarding from './SharePinOnboarding.svelte';

  const bookmarks = ownBookmarks;
  const nativeShell = isNativeShell();
  let queuedUrls = new Set<string>();
  let failedUrls = new Set<string>();
  let unknownQueuedUrls = new Set<string>();
  const emptyImportedUrls = writable<ImportedUrlBookmark[]>([]);
  const emptyImportedNotes = writable<ImportedNoteRef[]>([]);
  const emptyZapReceipts = writable<ZapReceiptRecord[]>([]);
  let postUrls: Readable<ImportedUrlBookmark[]> = emptyImportedUrls;
  let postNotes: Readable<ImportedNoteRef[]> = emptyImportedNotes;
  let targetedZapReceipts: Readable<ZapReceiptRecord[]> = emptyZapReceipts;
  let zapTargetSignature = '';
  let addOpen = false;
  let searchOpen = false;
  let searchQuery = '';
  let searchAllMine = false;
  let locallyReadUrls = new Set<string>();

  function handleSaved(event: CustomEvent<{ bookmark: ParsedBookmark; isPublic: boolean }>) {
    const { bookmark, isPublic } = event.detail;
    rememberOwnBookmark(bookmark, isPublic);
  }

  onMount(() => {
    refreshOwnBookmarks();
    refreshPendingPublishCount($session.pubkey);
  });

  // Debounce the "waiting to sync" banner. The durable-publish queue
  // enqueues a save before the network publish and removes it on the
  // server's 200, so a normal save — and every background drain retry —
  // flips $pendingPublishes 0→1→0 within a second or two. Because the
  // banner renders inline at the top of the list, each flip reflowed
  // everything below it and yanked the scroll position ("the page keeps
  // jumping"). Only surface it once a backlog has persisted past
  // SHOW_DELAY, and once shown let it linger briefly so a transient dip
  // to zero mid-drain doesn't blink it off.
  const SYNC_BANNER_SHOW_DELAY_MS = 12_000;
  const SINGLE_SYNC_BANNER_SHOW_DELAY_MS = 45_000;
  const SYNC_BANNER_HIDE_DELAY_MS = 600;
  let showSyncBanner = false;
  let syncBannerCount = 0;
  let syncBannerTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSyncBannerTimer(): void {
    if (syncBannerTimer !== null) {
      clearTimeout(syncBannerTimer);
      syncBannerTimer = null;
    }
  }

  function updateSyncBanner(count: number): void {
    if (count > 0) syncBannerCount = count;
    const want = count > 0;
    // Already in the target state — cancel any pending flip (this is
    // what collapses a fast 0→1→0 churn into no visible change at all).
    if (want === showSyncBanner) {
      clearSyncBannerTimer();
      return;
    }
    clearSyncBannerTimer();
    const delay = want
      ? (count === 1 ? SINGLE_SYNC_BANNER_SHOW_DELAY_MS : SYNC_BANNER_SHOW_DELAY_MS)
      : SYNC_BANNER_HIDE_DELAY_MS;
    syncBannerTimer = setTimeout(() => {
      showSyncBanner = want;
      syncBannerTimer = null;
    }, delay);
  }

  $: updateSyncBanner($pendingPublishes);

  onDestroy(clearSyncBannerTimer);

  // Sort is now ORDERING only — newest/zap-sats/oldest/title-az/title-za.
  // The "what set am I looking at" tab (all bookmarks / read later /
  // archives) is driven by the URL query param and surfaced via the
  // section nav tabs, not the sort row. This keeps the sort row
  // short enough to stay on one line on phone widths.
  type Sort = 'newest' | 'zap-sats' | 'oldest' | 'title-az' | 'title-za';
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
    ? createImportedBookmarksFeed({ authors: [$session.pubkey], limit: 200, decryptPrivate: $canSign })
    : emptyImportedUrls;

  $: postNotes = $session.pubkey
    ? createImportedNoteRefsFeed({ authors: [$session.pubkey], limit: 500, decryptPrivate: $canSign })
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
    failedUrls = new Set(stats.failedUrls);
    for (const url of missingKeyArchiveUrls($session.pubkey)) failedUrls.add(url);
    unknownQueuedUrls = stats.unknownUrls;
  }

  function hasCompletedArchive(bookmark: ParsedBookmark): boolean {
    if (bookmark.blossomHash) return true;
    if (bookmark.waybackUrl) return true;
    return $myArchives.has(bookmark.url);
  }

  function hasArchiveWorkflow(bookmark: ParsedBookmark): boolean {
    return bookmark.archivedForever ||
      hasCompletedArchive(bookmark) ||
      queuedUrls.has(bookmark.url) ||
      failedUrls.has(bookmark.url) ||
      unknownQueuedUrls.has(bookmark.url);
  }

  function filterBookmarks(
    list: ParsedBookmark[],
    currentView: View,
    readHiddenUrls: ReadonlySet<string>,
  ): ParsedBookmark[] {
    if (currentView === 'archived') return list.filter((b) => hasArchiveWorkflow(b));
    if (currentView === 'readlater') {
      return list.filter((b) => b.tags.includes('toread') && !readHiddenUrls.has(b.url));
    }
    if (currentView === 'media') return list.filter((b) => isPotentialMediaUrl(b.url));
    return list;
  }

  function sortBookmarks(
    list: ParsedBookmark[],
    currentSort: Sort,
    zapDataByEventId: Map<string, ZapAggregate> | null | undefined,
  ): ParsedBookmark[] {
    if (currentSort === 'zap-sats') return sortBookmarksByZapSats(list, zapDataByEventId);
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

  function synthesizeNoteRefBookmarks(
    importedNotes: ImportedNoteRef[],
    existing: ParsedBookmark[],
  ): ParsedBookmark[] {
    if (importedNotes.length === 0) return [];
    const existingUrls = new Set(existing.map((bookmark) => bookmark.url));
    const out: ParsedBookmark[] = [];
    for (const note of importedNotes) {
      const url = nostrNoteArchiveUrl(note.targetEventId);
      if (!url || existingUrls.has(url)) continue; // adopted posts already render
      existingUrls.add(url);
      out.push({
        url,
        title: 'Nostr post',
        description: '',
        tags: [],
        archivedForever: false,
        savedAt: note.savedAt,
        eventCreatedAt: note.listCreatedAt,
        curator: note.curator,
        eventId: `nip51-note:${note.listEventId}:${note.targetEventId}`,
        visibility: note.visibility,
      } as ParsedBookmark);
    }
    return out;
  }

  // E-tag note bookmarks (imported NIP-51 lists) used to render ONLY on
  // the posts tab — invisible to the main list and its search, so a note
  // the user bookmarked in Amethyst looked lost here. Synthesize URL-form
  // rows for any note ref not already adopted as a URL bookmark.
  $: noteRefBookmarks = synthesizeNoteRefBookmarks($postNotes, $bookmarks);
  $: allMineBookmarks = noteRefBookmarks.length > 0 ? [...$bookmarks, ...noteRefBookmarks] : $bookmarks;
  $: if (view !== 'readlater' && locallyReadUrls.size > 0) locallyReadUrls = new Set();
  $: visibleBaseBookmarks = filterBookmarks(allMineBookmarks, view, locallyReadUrls);
  $: activeSearchQuery = searchOpen ? searchQuery.trim() : '';
  $: searchSource = activeSearchQuery && searchAllMine ? allMineBookmarks : visibleBaseBookmarks;
  $: searchedBookmarks = activeSearchQuery
    ? searchLocalBookmarks(searchSource, activeSearchQuery, { limit: 10_000 })
    : visibleBaseBookmarks;
  $: nextZapTargetIds = bookmarkZapTargetEventIds($bookmarks).sort();
  $: nextZapTargetSignature = nextZapTargetIds.join(',');
  $: if (nextZapTargetSignature !== zapTargetSignature) {
    zapTargetSignature = nextZapTargetSignature;
    targetedZapReceipts = nextZapTargetIds.length > 0
      ? createTargetedZapReceiptFeed({ targetEventIds: nextZapTargetIds })
      : emptyZapReceipts;
  }
  $: zapSatsByEventId = tallyReceiptsInWindow($targetedZapReceipts, 0);
  $: sortedBookmarks = sortBookmarks(searchedBookmarks, $sort, zapSatsByEventId);
  $: overlaySearchResults = activeSearchQuery
    ? sortedBookmarks.slice(0, OVERLAY_RESULT_CAP).map(bookmarkToSearchResult)
    : [];
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

  function handleReadLaterChanged(event: CustomEvent<{ bookmark: ParsedBookmark; isReadLater: boolean }>): void {
    const next = new Set(locallyReadUrls);
    if (event.detail.isReadLater) next.delete(event.detail.bookmark.url);
    else next.add(event.detail.bookmark.url);
    locallyReadUrls = next;
  }
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
    { label: '⚡ sats',   id: 'zap-sats', current: $sort === 'zap-sats' },
  ]}
  onSort={setSort}
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
  searchPlaceholder={
    view === 'readlater' ? 'search read later...'
    : view === 'archived' ? 'search archived bookmarks...'
    : view === 'media' ? 'search media bookmarks...'
    : 'search your bookmarks...'
  }
  searchScopes={searchScopeOptions}
  searchResults={overlaySearchResults}
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
    <div class="archive-progress-actions">
      {#if failedArchiveCount > 0}
        <button type="button" on:click={() => void retryFailedArchives()}>
          retry failed
        </button>
      {/if}
      <button type="button" on:click={() => void maybeBackfill(true)}>
        check archives
      </button>
    </div>
  </section>
{/if}
{#if $privateDecryptIssue}
  <section class="private-notice" aria-live="polite">
    <span>
      {#if $privateDecryptIssue.reason === 'nip44-unsupported'}
        your signer doesn't support nip-44 encryption, so your private
        bookmarks can't be decrypted here. use a signer with nip-44
        support (or your nsec) to see them.
      {:else if $privateDecryptIssue.reason === 'signer-timeout'}
        your remote signer isn't responding — private bookmarks couldn't
        be decrypted. wake your signer, then retry.
      {:else}
        {$privateDecryptIssue.count} private bookmark chunk{$privateDecryptIssue.count === 1 ? '' : 's'}
        couldn't be decrypted — your private list may be incomplete.
        reconnect your signer, then retry.
      {/if}
    </span>
    <button type="button" on:click={() => refreshOwnBookmarks()}>retry</button>
  </section>
{:else if $session.pubkey && !$canSign}
  <section class="private-notice muted" aria-live="polite">
    <span>
      signed in read-only — unlock or reconnect your signer to view
      private bookmarks.
    </span>
  </section>
{/if}
{#if showSyncBanner}
  <section class="private-notice muted" aria-live="polite">
    <span>
      {syncBannerCount} save{syncBannerCount === 1 ? '' : 's'} waiting
      to sync — retried automatically while the app is open.
    </span>
  </section>
{/if}
<BookmarkList
  bookmarks={sortedBookmarks}
  summaryBookmarks={$bookmarks}
  archivedCountOverride={completedArchiveCount}
  mediaCountOverride={mediaBookmarkCount}
  paginationKey={paginationKey}
  loading={false}
  {zapSatsByEventId}
  showStats={true}
  freezeFeed={false}
  emptyMessage={
    activeSearchQuery ? `no matches for "${activeSearchQuery}"`
    : view === 'archived' ? 'no archived bookmarks yet — toggle "archive" on save'
    : view === 'readlater' ? 'nothing saved for later yet — toggle "read later" on save'
    : view === 'media' ? 'no media bookmarks yet — save a video or audio page'
    : 'no bookmarks yet — paste a URL to save your first'
  }
  on:readLaterChanged={handleReadLaterChanged}
>
  <svelte:fragment slot="prepend">
    <SharePinOnboarding />
    <Overlay
      open={addOpen && !nativeShell}
      ariaLabel="add a bookmark"
      on:close={() => (addOpen = false)}
    >
      <SaveBox on:saved={handleSaved} />
    </Overlay>
  </svelte:fragment>
</BookmarkList>

<style>
  .private-notice {
    max-width: 980px;
    margin: 0 24px 12px;
    padding: 10px 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    border: 1px solid var(--accent, #b8860b);
    font-size: 0.85rem;
  }

  .private-notice.muted {
    border-color: var(--rule);
    opacity: 0.85;
  }

  .private-notice button {
    flex-shrink: 0;
  }

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
  .archive-progress-actions {
    display: flex;
    flex: 0 0 auto;
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
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
    .archive-progress-actions {
      width: 100%;
      justify-content: flex-start;
    }
  }
</style>
