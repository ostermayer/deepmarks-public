<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { writable, type Readable } from 'svelte/store';
  import AppActionBar from '$lib/components/AppActionBar.svelte';
  import AppSectionNav from '$lib/components/AppSectionNav.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import SaveBox from '$lib/components/SaveBox.svelte';
  import Subheader from '$lib/components/Subheader.svelte';
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
  import { bookmarksForCollection, collectionTitleFromSlug } from '$lib/bookmark-collections';
  import { addBookmarkToCollection, ownCollections, refreshOwnCollections } from '$lib/nostr/collections';
  import { isNativeShell } from '$lib/native/runtime';
  import { searchLocalBookmarks } from '$lib/search/local-bookmark-search';
  import { bookmarkToSearchResult, OVERLAY_RESULT_CAP } from '$lib/search/search-result';
  import { session } from '$lib/stores/session';
  import { ownBookmarks, refreshOwnBookmarks, rememberOwnBookmark } from '$lib/stores/own-bookmarks';

  type Sort = 'newest' | 'zap-sats' | 'oldest' | 'title-az' | 'title-za';
  const emptyZapReceipts = writable<ZapReceiptRecord[]>([]);
  const nativeShell = isNativeShell();
  let sort: Sort = 'newest';
  let addOpen = false;
  let searchOpen = false;
  let searchQuery = '';
  let collectionError = '';
  let targetedZapReceipts: Readable<ZapReceiptRecord[]> = emptyZapReceipts;
  let zapTargetSignature = '';

  $: collectionSlug = $page.params.collection ?? '';
  $: collection = $ownCollections.find((item) => item.slug === collectionSlug) ?? null;
  $: collectionTitle = collection?.title ?? collectionTitleFromSlug(collectionSlug);
  $: collectionBookmarks = bookmarksForCollection($ownBookmarks, collection);
  $: activeSearchQuery = searchOpen ? searchQuery.trim() : '';
  $: searchedBookmarks = activeSearchQuery
    ? searchLocalBookmarks(collectionBookmarks, activeSearchQuery, { limit: 10_000 })
    : collectionBookmarks;
  $: sortedBookmarks = sortBookmarks(searchedBookmarks, sort, zapSatsByEventId);
  $: overlaySearchResults = activeSearchQuery
    ? sortedBookmarks.slice(0, OVERLAY_RESULT_CAP).map(bookmarkToSearchResult)
    : [];
  $: searchSummary = activeSearchQuery
    ? `${sortedBookmarks.length.toLocaleString()} ${sortedBookmarks.length === 1 ? 'match' : 'matches'}`
    : '';
  $: nextZapTargetIds = bookmarkZapTargetEventIds(collectionBookmarks).sort();
  $: nextZapTargetSignature = nextZapTargetIds.join(',');
  $: if (nextZapTargetSignature !== zapTargetSignature) {
    zapTargetSignature = nextZapTargetSignature;
    targetedZapReceipts = nextZapTargetIds.length > 0
      ? createTargetedZapReceiptFeed({ targetEventIds: nextZapTargetIds })
      : emptyZapReceipts;
  }
  $: zapSatsByEventId = tallyReceiptsInWindow($targetedZapReceipts, 0);
  $: collectionsCount = $ownCollections.length;

  onMount(() => {
    refreshOwnBookmarks();
    const pubkey = $session.pubkey;
    if (pubkey) void refreshOwnCollections(pubkey);
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

  async function handleSaved(event: CustomEvent<{ bookmark: ParsedBookmark; isPublic: boolean }>): Promise<void> {
    const { bookmark, isPublic } = event.detail;
    rememberOwnBookmark(bookmark, isPublic);
    const pubkey = $session.pubkey;
    if (pubkey) {
      try {
        const result = await addBookmarkToCollection(bookmark, collection ?? collectionTitle, pubkey, {
          visibility: collection?.visibility ?? 'public',
          title: collectionTitle,
        });
        await result.publish;
        collectionError = '';
      } catch (e) {
        collectionError = (e as Error).message || 'could not add bookmark to collection';
      }
    }
    addOpen = false;
  }

  function saveHref(): string {
    const params = new URLSearchParams({
      collection: collectionSlug,
      collectionVisibility: collection?.visibility ?? 'public',
      returnTo: `/app/collections/${collectionSlug}`,
    });
    return `/app/save?${params}`;
  }
</script>

<svelte:head><title>{collectionTitle} — Deepmarks</title></svelte:head>

<AppSectionNav
  active="collections"
  bookmarksCount={$ownBookmarks.length}
  {collectionsCount}
/>

<Subheader
  context={`collection · ${collectionTitle}`}
  sorts={[
    { label: 'newest',    id: 'newest',   current: sort === 'newest' },
    { label: 'oldest',    id: 'oldest',   current: sort === 'oldest' },
    { label: 'title a-z', id: 'title-az', current: sort === 'title-az' },
    { label: 'title z-a', id: 'title-za', current: sort === 'title-za' },
    { label: 'sats',      id: 'zap-sats', current: sort === 'zap-sats' },
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

{#if nativeShell}
  <div class="mobile-add-wrap">
    <a href={saveHref()}>add bookmark to {collectionTitle}</a>
  </div>
{/if}

<AppActionBar
  bind:searchOpen
  bind:searchQuery
  panelOnly
  compact
  searchPlaceholder={`search ${collectionTitle}...`}
  searchResults={overlaySearchResults}
/>

{#if collectionError}
  <p class="collection-error">{collectionError}</p>
{/if}

<BookmarkList
  bookmarks={sortedBookmarks}
  summaryBookmarks={collectionBookmarks}
  loading={false}
  emptyMessage={activeSearchQuery ? `no matches for "${activeSearchQuery}"` : `no bookmarks in ${collectionTitle} yet`}
  freezeFeed={false}
  {zapSatsByEventId}
  paginationKey={`collection:${collectionSlug}:${sort}:${activeSearchQuery}`}
>
  <svelte:fragment slot="prepend">
    {#if addOpen && !nativeShell}
      <SaveBox on:saved={handleSaved} />
    {/if}
  </svelte:fragment>
</BookmarkList>

<style>
  .mobile-add-wrap {
    padding: 12px 18px 2px;
  }
  .mobile-add-wrap a {
    display: block;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink-deep);
    padding: 10px 12px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
  }
  .mobile-add-wrap a:active {
    transform: scale(0.99);
  }
  .collection-error {
    margin: 10px 24px 0 62px;
    color: var(--coral-deep);
    font-size: 12px;
  }
  @media (max-width: 720px) {
    .collection-error {
      margin: 10px 16px 0;
    }
  }
</style>
