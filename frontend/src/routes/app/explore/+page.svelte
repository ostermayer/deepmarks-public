<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import Subheader from '$lib/components/Subheader.svelte';
  import { config } from '$lib/config';
  import { writable, type Readable } from 'svelte/store';
  import {
    compareBookmarksNewest,
    compareBookmarksOldest,
    type ParsedBookmark,
  } from '$lib/nostr/bookmarks';
  import {
    bookmarkZapTargetEventIds,
    sortBookmarksByZapSats,
  } from '$lib/nostr/bookmark-zap-target';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import {
    applyPopularityFloor,
    rankByPopularity,
    tallyReceiptsInWindow,
  } from '$lib/nostr/popularity';
  import {
    WINDOW_LABELS,
    customWindow,
    filterBookmarksByWindow,
    resolveWindow,
    type WindowKind,
    type WindowRange,
  } from '$lib/nostr/popularity-window';
  import {
    bucketize,
    countTags,
    countTagsWithZapSats,
    type TagCloudItem,
  } from '$lib/nostr/tag-cloud';
  import {
    createTargetedZapReceiptFeed,
    type ZapReceiptRecord,
  } from '$lib/nostr/zap-counts';

  type Sort = 'newest' | 'popular' | 'zap-sats' | 'oldest' | 'title-az';
  type Mode = 'bookmarks' | 'tags';
  type TagSort = 'popular' | 'zap-sats' | 'alpha';
  type TagView = 'list' | 'cloud';
  type TagCount = { name: string; count: number; zapSats?: number };

  const feed = createBookmarkFeed({ limit: 500 });
  const emptyZapReceipts = writable<ZapReceiptRecord[]>([]);

  let mode: Mode = 'bookmarks';
  let sort: Sort = 'newest';
  let tagSort: TagSort = 'popular';
  let tagView: TagView = 'list';
  let windowKind: WindowKind = 'all';
  let customSince = '';
  let customUntil = '';
  let targetedZapReceipts: Readable<ZapReceiptRecord[]> = emptyZapReceipts;
  let zapTargetSignature = '';

  $: routeMode = ($page.url.searchParams.get('mode') === 'tags' ? 'tags' : 'bookmarks') as Mode;
  $: routeSort = parseSort($page.url.searchParams.get('sort'));
  $: routeTagSort = (
    $page.url.searchParams.get('tagSort') === 'alpha' || $page.url.searchParams.get('tagSort') === 'zap-sats'
      ? $page.url.searchParams.get('tagSort')
      : 'popular'
  ) as TagSort;
  $: routeTagView = ($page.url.searchParams.get('view') === 'cloud' ? 'cloud' : 'list') as TagView;
  $: routeWindowKind = parseWindowKind($page.url.searchParams.get('window'));
  $: routeSince = $page.url.searchParams.get('since') ?? '';
  $: routeUntil = $page.url.searchParams.get('until') ?? '';
  $: selectedTag = routeMode === 'bookmarks'
    ? normalizeTag($page.url.searchParams.get('tag') ?? '')
    : '';

  $: if (mode !== routeMode) mode = routeMode;
  $: if (sort !== routeSort) sort = routeSort;
  $: if (tagSort !== routeTagSort) tagSort = routeTagSort;
  $: if (tagView !== routeTagView) tagView = routeTagView;
  $: if (windowKind !== routeWindowKind) windowKind = routeWindowKind;
  $: if (customSince !== routeSince) customSince = routeSince;
  $: if (customUntil !== routeUntil) customUntil = routeUntil;

  function titleFor(bookmark: ParsedBookmark): string {
    return (bookmark.title || bookmark.url).toLocaleLowerCase();
  }

  function normalizeTag(raw: string): string {
    return raw.trim().replace(/^#/, '').toLocaleLowerCase();
  }

  function bookmarkHasTag(bookmark: ParsedBookmark, tag: string): boolean {
    return bookmark.tags.some((item) => item.toLocaleLowerCase() === tag);
  }

  function parseSort(raw: string | null): Sort {
    if (raw === 'popular' || raw === 'zap-sats' || raw === 'oldest' || raw === 'title-az') return raw;
    return 'newest';
  }

  function parseWindowKind(raw: string | null): WindowKind {
    if (raw === '24h' || raw === 'week' || raw === 'month' || raw === 'year' || raw === 'custom') return raw;
    return 'all';
  }

  function selectedWindow(kind: WindowKind, since: string, until: string): WindowRange {
    if (kind !== 'custom') return resolveWindow(kind);
    return customWindow(
      since ? new Date(`${since}T00:00:00Z`) : null,
      until ? new Date(`${until}T23:59:59Z`) : null,
    );
  }

  function sortBookmarks(
    input: ParsedBookmark[],
    currentSort: Sort,
    receiptList: Parameters<typeof tallyReceiptsInWindow>[0],
    range: WindowRange,
  ): ParsedBookmark[] {
    if (currentSort === 'popular') {
      const zapData = tallyReceiptsInWindow(receiptList, range.sinceSec, range.untilSec);
      return applyPopularityFloor(rankByPopularity(input, zapData), {
        editorialPubkeys: config.deepmarksEditorialPubkeys,
      });
    }
    if (currentSort === 'zap-sats') {
      const zapData = tallyReceiptsInWindow(receiptList, range.sinceSec, range.untilSec);
      return sortBookmarksByZapSats(input, zapData);
    }

    const out = input.slice();
    if (currentSort === 'oldest') out.sort(compareBookmarksOldest);
    else if (currentSort === 'title-az') out.sort((a, b) => titleFor(a).localeCompare(titleFor(b)));
    else out.sort(compareBookmarksNewest);
    return out;
  }

  function sortTagCounts(counts: TagCount[], currentSort: TagSort): TagCount[] {
    const out = counts.slice();
    if (currentSort === 'alpha') out.sort((a, b) => a.name.localeCompare(b.name));
    else if (currentSort === 'zap-sats') out.sort((a, b) =>
      (b.zapSats ?? 0) - (a.zapSats ?? 0) || b.count - a.count || a.name.localeCompare(b.name),
    );
    else out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return out;
  }

  function exploreUrl(options: {
    mode?: Mode;
    sort?: Sort;
    tagSort?: TagSort;
    tagView?: TagView;
    tag?: string;
    windowKind?: WindowKind;
    since?: string;
    until?: string;
  }): string {
    const nextMode = options.mode ?? mode;
    const nextSort = options.sort ?? sort;
    const nextTagSort = options.tagSort ?? tagSort;
    const nextTagView = options.tagView ?? tagView;
    const nextTag = options.tag !== undefined ? normalizeTag(options.tag) : selectedTag;
    const nextWindowKind = options.windowKind ?? windowKind;
    const nextSince = options.since ?? customSince;
    const nextUntil = options.until ?? customUntil;
    const params = new URLSearchParams();

    if (nextMode === 'tags') {
      params.set('mode', 'tags');
      if (nextTagSort !== 'popular') params.set('tagSort', nextTagSort);
      if (nextTagView !== 'list') params.set('view', nextTagView);
    } else if (nextSort !== 'newest') {
      params.set('sort', nextSort);
    }

    if (nextMode === 'bookmarks' && nextTag) params.set('tag', nextTag);
    if (nextWindowKind !== 'all') {
      params.set('window', nextWindowKind);
      if (nextWindowKind === 'custom') {
        if (nextSince) params.set('since', nextSince);
        if (nextUntil) params.set('until', nextUntil);
      }
    }

    const suffix = params.toString();
    return suffix ? `/app/explore?${suffix}` : '/app/explore';
  }

  function navigate(options: Parameters<typeof exploreUrl>[0]): void {
    void goto(exploreUrl(options), { keepFocus: true });
  }

  function tagHref(tag: string): string {
    const params = new URLSearchParams({ tag });
    if (windowKind !== 'all') {
      params.set('window', windowKind);
      if (windowKind === 'custom') {
        if (customSince) params.set('since', customSince);
        if (customUntil) params.set('until', customUntil);
      }
    }
    return `/app/explore?${params.toString()}`;
  }

  function updateCustomDate(which: 'since' | 'until', event: Event): void {
    const value = event.currentTarget instanceof HTMLInputElement
      ? event.currentTarget.value
      : '';
    navigate({
      windowKind: 'custom',
      since: which === 'since' ? value : customSince,
      until: which === 'until' ? value : customUntil,
    });
  }

  $: activeWindow = selectedWindow(windowKind, customSince, customUntil);
  $: filteredFeed = selectedTag
    ? filterBookmarksByWindow($feed.filter((bookmark) => bookmarkHasTag(bookmark, selectedTag)), activeWindow)
    : filterBookmarksByWindow($feed, activeWindow);
  $: tagSource = filterBookmarksByWindow($feed, activeWindow);
  $: nextZapTargetIds = bookmarkZapTargetEventIds($feed).sort();
  $: nextZapTargetSignature = nextZapTargetIds.join(',');
  $: if (nextZapTargetSignature !== zapTargetSignature) {
    zapTargetSignature = nextZapTargetSignature;
    targetedZapReceipts = nextZapTargetIds.length > 0
      ? createTargetedZapReceiptFeed({ targetEventIds: nextZapTargetIds })
      : emptyZapReceipts;
  }
  $: zapSatsByEventId = tallyReceiptsInWindow($targetedZapReceipts, activeWindow.sinceSec, activeWindow.untilSec);
  $: bookmarks = sortBookmarks(filteredFeed, sort, $targetedZapReceipts, activeWindow);
  $: tagCounts = sortTagCounts(
    tagSort === 'zap-sats' ? countTagsWithZapSats(tagSource, zapSatsByEventId) : countTags(tagSource),
    tagSort,
  );
  $: tagCloud = bucketize(
    tagCounts.slice(0, 48).map((item) => ({
      name: item.name,
      count: tagSort === 'zap-sats' ? (item.zapSats ?? 0) : item.count,
    })),
  ) as TagCloudItem[];
  $: feedUrl = mode === 'bookmarks'
    ? (selectedTag
      ? `/feed/tags/${encodeURIComponent(selectedTag)}.xml`
      : sort === 'popular'
        ? '/feed/popular.xml'
        : '/feed/recent.xml')
    : '';
</script>

<svelte:head><title>explore — Deepmarks</title></svelte:head>

<Subheader
  context={selectedTag ? `global · #${selectedTag}` : 'global · explore'}
  {feedUrl}
  feedLabel={selectedTag ? `Deepmarks #${selectedTag} feed` : sort === 'popular' ? 'Deepmarks popular feed' : 'Deepmarks recent feed'}
/>

<div class="explore-toolbar">
  <div class="segments">
    <button type="button" class:active={mode === 'bookmarks'} on:click={() => navigate({ mode: 'bookmarks' })}>bookmarks</button>
    <button type="button" class:active={mode === 'tags'} on:click={() => navigate({ mode: 'tags', tag: '' })}>tags</button>
  </div>

  {#if mode === 'bookmarks'}
    <div class="segments">
      <button type="button" class:active={sort === 'newest'} on:click={() => navigate({ sort: 'newest' })}>newest</button>
      <button type="button" class:active={sort === 'popular'} on:click={() => navigate({ sort: 'popular' })}>popular</button>
      <button type="button" class:active={sort === 'oldest'} on:click={() => navigate({ sort: 'oldest' })}>oldest</button>
      <button type="button" class:active={sort === 'title-az'} on:click={() => navigate({ sort: 'title-az' })}>title a-z</button>
      <button type="button" class:active={sort === 'zap-sats'} on:click={() => navigate({ sort: 'zap-sats' })}>⚡ sats</button>
    </div>
  {:else}
    <div class="segments">
      <button type="button" class:active={tagView === 'list'} on:click={() => navigate({ tagView: 'list' })}>list</button>
      <button type="button" class:active={tagView === 'cloud'} on:click={() => navigate({ tagView: 'cloud' })}>tag cloud</button>
    </div>
    <div class="segments">
      <button type="button" class:active={tagSort === 'popular'} on:click={() => navigate({ tagSort: 'popular' })}>popular</button>
      <button type="button" class:active={tagSort === 'alpha'} on:click={() => navigate({ tagSort: 'alpha' })}>a-z</button>
      <button type="button" class:active={tagSort === 'zap-sats'} on:click={() => navigate({ tagSort: 'zap-sats' })}>⚡ sats</button>
    </div>
  {/if}

  <div class="segments window-segments">
    {#each WINDOW_LABELS as w}
      <button
        type="button"
        class:active={windowKind === w.kind}
        on:click={() => navigate({ windowKind: w.kind })}
      >
        {w.label}
      </button>
    {/each}
    <button
      type="button"
      class:active={windowKind === 'custom'}
      on:click={() => navigate({ windowKind: 'custom' })}
    >
      custom
    </button>
  </div>

  {#if windowKind === 'custom'}
    <div class="custom-range">
      <label>
        <span>from</span>
        <input type="date" value={customSince} on:change={(event) => updateCustomDate('since', event)} />
      </label>
      <label>
        <span>to</span>
        <input type="date" value={customUntil} on:change={(event) => updateCustomDate('until', event)} />
      </label>
    </div>
  {/if}
</div>

{#if mode === 'tags'}
  <main class="tag-explorer">
    <h1>global tags</h1>
    {#if tagCounts.length === 0}
      <div class="empty">no public tags yet</div>
    {:else if tagView === 'cloud'}
      <div class="cloud">
        {#each tagCloud as t}
          <a href={tagHref(t.name)} class={`s${t.weight}`}>{t.name}</a>
        {/each}
      </div>
    {:else}
      <div class="tag-list">
        {#each tagCounts as t}
          <a href={tagHref(t.name)}>
            <span>{t.name}</span>
            <strong class="num-retro">
              {#if tagSort === 'zap-sats'}
                ⚡ {(t.zapSats ?? 0).toLocaleString()} · {t.count.toLocaleString()}
              {:else}
                ({t.count.toLocaleString()})
              {/if}
            </strong>
          </a>
        {/each}
      </div>
    {/if}
  </main>
{:else}
  {#if selectedTag}
    <div class="active-filter">
      <span>showing public bookmarks tagged <strong>#{selectedTag}</strong></span>
      <a href="/app/explore">clear</a>
    </div>
  {/if}

  <BookmarkList
    bookmarks={bookmarks}
    summaryBookmarks={tagSource}
    loading={true}
    paginationKey={`${sort}:${selectedTag}:${windowKind}:${customSince}:${customUntil}`}
    emptyMessage={sort === 'popular' ? 'no popular bookmarks yet' : 'no public bookmarks yet'}
    tagScope="network"
    {zapSatsByEventId}
    showPendingBanner={false}
  />
{/if}

<style>
  .explore-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 10px 24px 10px 62px;
    border-bottom: 1px solid var(--rule);
    background: var(--paper);
  }
  .segments {
    display: inline-flex;
    gap: 4px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    padding: 3px;
    background: var(--surface);
  }
  .segments button {
    border: 0;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    padding: 6px 10px;
    border-radius: 5px;
  }
  .segments button.active {
    color: var(--ink-deep);
    background: var(--paper-warm);
    font-weight: 600;
  }
  .segments button:hover {
    color: var(--coral-deep);
  }
  .window-segments {
    margin-left: auto;
  }
  .custom-range {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 11px;
  }
  .custom-range label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .custom-range input {
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: var(--surface);
    color: var(--ink-deep);
    font: inherit;
    font-size: 11px;
    padding: 5px 7px;
  }
  .custom-range input:focus {
    outline: 2px solid var(--coral-soft);
    border-color: var(--coral);
  }
  .active-filter {
    max-width: 1180px;
    margin: 0 auto;
    padding: 14px 24px 0;
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--muted);
    font-size: 13px;
  }
  .active-filter a {
    color: var(--link);
    text-decoration: none;
    font-weight: 600;
  }
  .tag-explorer {
    max-width: 1040px;
    margin: 0 auto;
    padding: 36px 24px;
  }
  h1 {
    margin: 0 0 18px;
    color: var(--ink-deep);
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 24px;
    font-weight: 600;
    letter-spacing: 0;
  }
  .empty {
    color: var(--muted);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
  }
  .tag-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 8px 18px;
  }
  .tag-list a {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    color: var(--ink-deep);
    border-bottom: 1px solid var(--rule);
    padding: 8px 0;
    text-decoration: none;
  }
  .tag-list a:hover { color: var(--coral); }
  .tag-list strong { color: var(--muted); font-weight: 600; }
  .cloud { line-height: 2.4; }
  .cloud a { display: inline-block; margin-right: 14px; color: var(--link); }
  .cloud a:hover { color: var(--coral); text-decoration: none; }
  .cloud .s1 { font-size: 12px; color: var(--muted); }
  .cloud .s2 { font-size: 14px; }
  .cloud .s3 { font-size: 18px; font-weight: 600; }
  .cloud .s4 { font-size: 24px; font-weight: 600; }
  .cloud .s5 { font-size: 32px; font-weight: 700; color: var(--ink-deep); }
  @media (max-width: 720px) {
    .explore-toolbar {
      padding: 10px 20px;
    }
    .window-segments {
      margin-left: 0;
    }
    .custom-range {
      width: 100%;
      flex-wrap: wrap;
    }
  }
</style>
