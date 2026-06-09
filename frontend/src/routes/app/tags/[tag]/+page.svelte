<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { derived, writable, type Readable } from 'svelte/store';
  import Subheader from '$lib/components/Subheader.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
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
  import { ownBookmarks, refreshOwnBookmarks } from '$lib/stores/own-bookmarks';

  type Sort = 'newest' | 'zap-sats' | 'oldest' | 'title-az' | 'title-za';
  const emptyZapReceipts = writable<ZapReceiptRecord[]>([]);
  let sort: Sort = 'newest';
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
  $: sortedTagged = sortBookmarks($ownTagged, sort, zapSatsByEventId);
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
/>

<BookmarkList
  bookmarks={sortedTagged}
  loading={false}
  {emptyMessage}
  freezeFeed={false}
  {zapSatsByEventId}
/>
