<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { derived, writable, type Readable } from 'svelte/store';
  import AppActionBar from '$lib/components/AppActionBar.svelte';
  import Subheader from '$lib/components/Subheader.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import SaveBox from '$lib/components/SaveBox.svelte';
  import ToolbarActions from '$lib/components/ToolbarActions.svelte';
  import {
    compareBookmarksNewest,
    compareBookmarksOldest,
    type ParsedBookmark,
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
  import { isNativeShell } from '$lib/native/runtime';
  import { searchLocalBookmarks } from '$lib/search/local-bookmark-search';
  import { bookmarkToSearchResult, OVERLAY_RESULT_CAP } from '$lib/search/search-result';
  import { ownBookmarks, refreshOwnBookmarks, rememberOwnBookmark } from '$lib/stores/own-bookmarks';

  type Sort = 'newest' | 'zap-sats' | 'oldest' | 'title-az' | 'title-za';
  const emptyZapReceipts = writable<ZapReceiptRecord[]>([]);
  const nativeShell = isNativeShell();
  let sort: Sort = 'newest';
  let addOpen = false;
  let searchOpen = false;
  let searchQuery = '';
  let targetedZapReceipts: Readable<ZapReceiptRecord[]> = emptyZapReceipts;
  let zapTargetSignature = '';

  $: tag = $page.params.tag ?? '';
  $: ownTagged = derived(ownBookmarks, ($bookmarks) =>
    $bookmarks.filter((b) => b.tags.some((t) => t.toLowerCase() === tag.toLowerCase())),
  );
  $: nextZapTargetIds = bookmarkZapTargetEventIds($ownTagged).sort();
  $: nextZapTargetSignature = nextZapTargetIds.join(',');
  $: if (nextZapTargetSignature !== zapTargetSignature) {
    zapTargetSignature = nextZapTargetSignature;
    targetedZapReceipts = nextZapTargetIds.length > 0
      ? createTargetedZapReceiptFeed({ targetEventIds: nextZapTargetIds })
      : emptyZapReceipts;
  }
  $: zapSatsByEventId = tallyReceiptsInWindow($targetedZapReceipts, 0);
  $: activeSearchQuery = searchOpen ? searchQuery.trim() : '';
  $: searchedTagged = activeSearchQuery
    ? searchLocalBookmarks($ownTagged, activeSearchQuery, { limit: 10_000 })
    : $ownTagged;
  $: sortedTagged = sortBookmarks(searchedTagged, sort, zapSatsByEventId);
  $: overlaySearchResults = activeSearchQuery
    ? sortedTagged.slice(0, OVERLAY_RESULT_CAP).map(bookmarkToSearchResult)
    : [];
  $: searchSummary = activeSearchQuery
    ? `${sortedTagged.length.toLocaleString()} ${sortedTagged.length === 1 ? 'match' : 'matches'}`
    : '';
  $: pageContext = `my tag · ${tag}`;
  $: emptyMessage = `no saved bookmarks tagged "${tag}" yet`;

  // When the tag page is the first surface the user lands on (e.g.
  // following a saved link straight to /app/tags/ai), the ownBookmarks
  // store may not have been hydrated yet. Kick the loader explicitly.
  onMount(() => {
    refreshOwnBookmarks();
  });

  function setSort(id: string): void {
    sort = id as Sort;
  }

  function handleSaved(event: CustomEvent<{ bookmark: ParsedBookmark; isPublic: boolean }>): void {
    const { bookmark, isPublic } = event.detail;
    rememberOwnBookmark(bookmark, isPublic);
    addOpen = false;
  }

  function titleFor(bookmark: ParsedBookmark): string {
    return (bookmark.title || bookmark.url).toLocaleLowerCase();
  }

  function sortBookmarks(
    list: ParsedBookmark[],
    currentSort: Sort,
    zapDataByEventId: Map<string, ZapAggregate> | null | undefined,
  ): ParsedBookmark[] {
    if (currentSort === 'zap-sats') return sortBookmarksByZapSats(list, zapDataByEventId);
    const sorted = list.slice();
    if (currentSort === 'oldest') sorted.sort(compareBookmarksOldest);
    else if (currentSort === 'title-az') sorted.sort((a, b) => titleFor(a).localeCompare(titleFor(b)));
    else if (currentSort === 'title-za') sorted.sort((a, b) => titleFor(b).localeCompare(titleFor(a)));
    else sorted.sort(compareBookmarksNewest);
    return sorted;
  }
</script>

<svelte:head><title>my {tag} — Deepmarks</title></svelte:head>

<Subheader
  context={pageContext}
  sorts={[
    { label: 'newest',    id: 'newest',   current: sort === 'newest' },
    { label: 'oldest',    id: 'oldest',   current: sort === 'oldest' },
    { label: 'title a-z', id: 'title-az', current: sort === 'title-az' },
    { label: 'title z-a', id: 'title-za', current: sort === 'title-za' },
    { label: '⚡ sats',   id: 'zap-sats', current: sort === 'zap-sats' },
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
  searchPlaceholder={`search #${tag}...`}
  searchResults={overlaySearchResults}
/>

<BookmarkList
  bookmarks={sortedTagged}
  loading={false}
  emptyMessage={activeSearchQuery ? `no matches for "${activeSearchQuery}"` : emptyMessage}
  freezeFeed={false}
  {zapSatsByEventId}
  paginationKey={`tag:${tag}:${sort}:${activeSearchQuery}`}
>
  <svelte:fragment slot="prepend">
    {#if addOpen && !nativeShell}
      <SaveBox prefillTags={[tag]} on:saved={handleSaved} />
    {/if}
  </svelte:fragment>
</BookmarkList>
