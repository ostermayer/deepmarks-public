<script lang="ts">
  import { writable, type Readable } from 'svelte/store';
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

  // Same source as network — feed is already sorted newest-first.
  const feed = createBookmarkFeed({ limit: 200 });
  const emptyZapReceipts = writable<ZapReceiptRecord[]>([]);
  type Sort = 'newest' | 'zap-sats';
  let sort: Sort = 'newest';
  let targetedZapReceipts: Readable<ZapReceiptRecord[]> = emptyZapReceipts;
  let zapTargetSignature = '';

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

<BookmarkList
  bookmarks={sortedFeed}
  loading={true}
  freezeTagCloud={true}
  emptyMessage="no recent bookmarks yet"
  tagScope="network"
  {zapSatsByEventId}
/>
