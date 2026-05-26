<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { onDestroy, onMount } from 'svelte';
  import { bucketize, countTags, type TagCloudItem } from '$lib/nostr/tag-cloud';
  import { ownBookmarks, refreshOwnBookmarks } from '$lib/stores/own-bookmarks';

  type View = 'list' | 'cloud';
  type Sort = 'popular' | 'alpha';
  type TagCount = ReturnType<typeof countTags>[number];

  // Debounce snapshots so a burst of bookmark events arriving in the
  // same tick doesn't paint the cloud N times in a row. 250ms is
  // enough to coalesce bursts while staying imperceptible — the old
  // 900ms felt like a real load delay on power-user libraries with
  // hundreds of tags.
  const TAG_SNAPSHOT_DELAY_MS = 250;

  let view: View = 'list';
  let sort: Sort = 'popular';
  let displayedSort: Sort = 'popular';
  let displayedCounts: TagCount[] = [];
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSnapshotSignature = '';

  $: requestedView = $page.url.searchParams.get('view');
  $: routeView = requestedView === 'cloud' || requestedView === 'list'
    ? requestedView as View
    : 'list';
  $: requestedSort = $page.url.searchParams.get('sort');
  $: routeSort = (requestedSort === 'alpha' ? 'alpha' : 'popular') as Sort;

  $: if (view !== routeView) view = routeView;
  $: if (sort !== routeSort) {
    sort = routeSort;
    primeDisplayedCounts(routeSort);
  }

  // Personal tags only. Global tag discovery now lives on /app/explore,
  // so this tab never mixes the user's private/local tag set with the
  // public network tag cloud.
  $: rawCounts = sortCounts(countTags($ownBookmarks), sort);
  $: scheduleSnapshot(rawCounts, sort);
  // Cloud limit kept smaller — visual cloud only makes sense when the
  // population is small enough to render at varied sizes. List view
  // gets the full set.
  $: cloud = bucketize(displayedCounts.slice(0, 80)) as TagCloudItem[];

  onMount(() => {
    refreshOwnBookmarks();
  });

  onDestroy(() => {
    if (snapshotTimer) clearTimeout(snapshotTimer);
  });

  function routeFor(nextView: View, nextSort: Sort = sort): string {
    const qs = new URLSearchParams();
    qs.set('view', nextView);
    if (nextSort !== 'popular') qs.set('sort', nextSort);
    const suffix = qs.toString();
    return suffix ? `/app/tags?${suffix}` : '/app/tags';
  }

  function setView(nextView: View): void {
    view = nextView;
    void goto(routeFor(nextView), { keepFocus: true, noScroll: true });
  }

  function setSort(nextSort: Sort): void {
    sort = nextSort;
    primeDisplayedCounts(nextSort);
    void goto(routeFor(view, nextSort), { keepFocus: true, noScroll: true });
  }

  function tagHref(tag: string): string {
    return `/app/tags/${encodeURIComponent(tag)}`;
  }

  function cacheKey(nextSort: Sort = sort): string {
    return `deepmarks-tags:mine:${nextSort}:v2`;
  }

  function loadCachedCounts(nextSort: Sort = sort): TagCount[] {
    if (!browser) return [];
    try {
      const raw = localStorage.getItem(cacheKey(nextSort));
      const parsed = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is TagCount =>
        !!item &&
        typeof item.name === 'string' &&
        typeof item.count === 'number',
      );
    } catch {
      return [];
    }
  }

  function saveCachedCounts(nextSort: Sort, counts: TagCount[]): void {
    if (!browser) return;
    try {
      localStorage.setItem(cacheKey(nextSort), JSON.stringify(counts));
    } catch {
      // Quota/private mode: live tags still render.
    }
  }

  function sortCounts(counts: TagCount[], currentSort: Sort): TagCount[] {
    const out = counts.slice();
    if (currentSort === 'alpha') out.sort((a, b) => a.name.localeCompare(b.name));
    else out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return out;
  }

  function primeDisplayedCounts(nextSort: Sort = sort): void {
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
    displayedSort = nextSort;
    displayedCounts = loadCachedCounts(nextSort);
    lastSnapshotSignature = '';
  }

  function signatureFor(nextSort: Sort, counts: TagCount[]): string {
    return `${nextSort}:${counts.map((t) => `${t.name}:${t.count}`).join('|')}`;
  }

  function scheduleSnapshot(counts: TagCount[], nextSort: Sort): void {
    if (displayedSort !== nextSort) primeDisplayedCounts(nextSort);
    const signature = signatureFor(nextSort, counts);
    if (signature === lastSnapshotSignature) return;
    lastSnapshotSignature = signature;

    if (snapshotTimer) clearTimeout(snapshotTimer);
    if (counts.length === 0) {
      if (displayedCounts.length === 0) displayedCounts = [];
      return;
    }
    snapshotTimer = setTimeout(() => {
      if (sort !== nextSort || lastSnapshotSignature !== signature) return;
      displayedSort = nextSort;
      displayedCounts = counts;
      saveCachedCounts(nextSort, counts);
      snapshotTimer = null;
    }, TAG_SNAPSHOT_DELAY_MS);
  }
</script>

<svelte:head><title>my tags — Deepmarks</title></svelte:head>

<div class="container">
  <div class="toolbar">
    <div class="segments">
      <button type="button" on:click={() => setView('list')} class:active={view === 'list'}>list</button>
      <button type="button" on:click={() => setView('cloud')} class:active={view === 'cloud'}>tag cloud</button>
    </div>
    <div class="segments">
      <button type="button" on:click={() => setSort('popular')} class:active={sort === 'popular'}>popular</button>
      <button type="button" on:click={() => setSort('alpha')} class:active={sort === 'alpha'}>a-z</button>
    </div>
  </div>

  <h1>my tags</h1>

  {#if displayedCounts.length === 0}
    <div class="empty">no items</div>
  {:else if view === 'list'}
    <div class="tag-list">
      {#each displayedCounts as t}
        <a href={tagHref(t.name)}>
          <span>{t.name}</span>
          <strong class="num-retro">({t.count})</strong>
        </a>
      {/each}
    </div>
  {:else}
    <div class="cloud">
      {#each cloud as t}
        <a href={tagHref(t.name)} class={`s${t.weight}`}>{t.name}</a>
      {/each}
    </div>
  {/if}
</div>

<style>
  .container { max-width: 1040px; margin: 0 auto; padding: 36px 24px; }
  h1 {
    margin: 0 0 18px;
    color: var(--ink-deep);
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 24px;
    font-weight: 600;
    letter-spacing: 0;
  }
  .toolbar {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 22px;
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
    font-size: 13px;
    padding: 6px 10px;
    border-radius: 5px;
  }
  .segments button.active {
    color: var(--ink-deep);
    background: var(--paper-warm);
  }
  .segments button:hover {
    color: var(--coral-deep);
  }
  .empty { color: var(--muted); font-size: 13px; padding: 40px 0; text-align: center; }
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
</style>
