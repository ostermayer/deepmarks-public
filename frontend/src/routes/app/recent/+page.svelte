<script lang="ts">
  import { writable, type Readable } from 'svelte/store';
  import AppActionBar from '$lib/components/AppActionBar.svelte';
  import Subheader from '$lib/components/Subheader.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import { compareBookmarksNewest, type ParsedBookmark } from '$lib/nostr/bookmarks';
  import {
    bookmarkZapTargetEventIds,
    sortBookmarksByZapSats,
  } from '$lib/nostr/bookmark-zap-target';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import { tallyReceiptsInWindow, type ZapAggregate } from '$lib/nostr/popularity';
  import {
    createTargetedZapReceiptFeed,
    type ZapReceiptRecord,
  } from '$lib/nostr/zap-counts';
  import { searchLocalBookmarks } from '$lib/search/local-bookmark-search';

  // Same source as network — feed is already sorted newest-first.
  const feed = createBookmarkFeed({ limit: 200 });
  const emptyZapReceipts = writable<ZapReceiptRecord[]>([]);
  type Sort = 'newest' | 'zap-sats';
  let sort: Sort = 'newest';
  let targetedZapReceipts: Readable<ZapReceiptRecord[]> = emptyZapReceipts;
  let zapTargetSignature = '';
  let searchOpen = false;
  let searchQuery = '';

  function setSort(id: string): void {
    sort = id as Sort;
  }

  function sortBookmarks(
    list: ParsedBookmark[],
    currentSort: Sort,
    zapDataByEventId: Map<string, ZapAggregate> | null | undefined,
  ): ParsedBookmark[] {
    if (currentSort === 'zap-sats') return sortBookmarksByZapSats(list, zapDataByEventId);
    return list.slice().sort(compareBookmarksNewest);
  }

  $: nextZapTargetIds = bookmarkZapTargetEventIds($feed).sort();
  $: nextZapTargetSignature = nextZapTargetIds.join(',');
  $: if (nextZapTargetSignature !== zapTargetSignature) {
    zapTargetSignature = nextZapTargetSignature;
    targetedZapReceipts = nextZapTargetIds.length > 0
      ? createTargetedZapReceiptFeed({ targetEventIds: nextZapTargetIds })
      : emptyZapReceipts;
  }
  $: zapSatsByEventId = tallyReceiptsInWindow($targetedZapReceipts, 0);
  $: sortedFeed = sortBookmarks($feed, sort, zapSatsByEventId);
  $: activeSearchQuery = searchOpen ? searchQuery.trim() : '';
  $: searchedFeed = activeSearchQuery
    ? searchLocalBookmarks(sortedFeed, activeSearchQuery, { limit: 10_000 })
    : sortedFeed;
  $: searchSummary = activeSearchQuery
    ? `${searchedFeed.length.toLocaleString()} match${searchedFeed.length === 1 ? '' : 'es'}`
    : '';
</script>

<svelte:head><title>recent — Deepmarks</title></svelte:head>

<Subheader
  context="global · recent"
  feedUrl="/feed/recent.xml"
  feedLabel="Deepmarks recent feed"
  sorts={[
    { label: 'newest', id: 'newest', current: sort === 'newest' },
    { label: '⚡ sats', id: 'zap-sats', current: sort === 'zap-sats' },
  ]}
  onSort={setSort}
/>

<AppActionBar
  bind:searchOpen
  bind:searchQuery
  addDisabled={true}
  searchPlaceholder="search recent bookmarks..."
  resultSummary={searchSummary}
  on:toggleSearch={() => (searchOpen = !searchOpen)}
/>

<BookmarkList
  bookmarks={searchedFeed}
  loading={true}
  freezeTagCloud={true}
  paginationKey={`recent:${sort}:${activeSearchQuery}`}
  emptyMessage={activeSearchQuery ? 'no matching recent bookmarks' : 'no recent bookmarks yet'}
  tagScope="network"
  {zapSatsByEventId}
/>
