<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { onDestroy } from 'svelte';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import { bucketize, countTags, type TagCloudItem } from '$lib/nostr/tag-cloud';
  import { ownBookmarks } from '$lib/stores/own-bookmarks';

  type Scope = 'network' | 'mine';
  type View = 'list' | 'cloud';
  type TagCount = ReturnType<typeof countTags>[number];

  const feed = createBookmarkFeed({ limit: 500 });
  const TAG_SNAPSHOT_DELAY_MS = 900;

  let scope: Scope = 'network';
  let view: View = 'cloud';
  let displayedScope: Scope = 'network';
  let displayedCounts: TagCount[] = [];
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSnapshotSignature = '';
  let routeInitialized = false;

  $: routeScope = ($page.url.searchParams.get('scope') === 'mine' ? 'mine' : 'network') as Scope;
  $: requestedView = $page.url.searchParams.get('view');
  $: routeView = requestedView === 'cloud' || requestedView === 'list'
    ? requestedView as View
    : (routeScope === 'mine' ? 'list' : 'cloud');

  $: if (!routeInitialized || scope !== routeScope) {
    routeInitialized = true;
    scope = routeScope;
    primeDisplayedCounts(scope);
  }
  $: if (view !== routeView) view = routeView;

  $: networkCounts = countTags($feed).slice(0, 80);
  $: mineCounts = countTags($ownBookmarks).slice(0, 200);
  $: rawCounts = scope === 'mine' ? mineCounts : networkCounts;
  $: scheduleSnapshot(scope, rawCounts);
  $: cloud = bucketize(displayedCounts.slice(0, scope === 'mine' ? 80 : 48)) as TagCloudItem[];

  onDestroy(() => {
    if (snapshotTimer) clearTimeout(snapshotTimer);
  });

  function routeFor(nextScope: Scope, nextView: View): string {
    const qs = new URLSearchParams();
    if (nextScope === 'mine') qs.set('scope', 'mine');
    qs.set('view', nextView);
    const suffix = qs.toString();
    return suffix ? `/app/tags?${suffix}` : '/app/tags';
  }

  function setScope(nextScope: Scope): void {
    const nextView = nextScope === scope ? view : (nextScope === 'mine' ? 'list' : 'cloud');
    scope = nextScope;
    view = nextView;
    primeDisplayedCounts(nextScope);
    void goto(routeFor(nextScope, nextView), { keepFocus: true, noScroll: true });
  }

  function setView(nextView: View): void {
    view = nextView;
    void goto(routeFor(scope, nextView), { keepFocus: true, noScroll: true });
  }

  function tagHref(tag: string): string {
    const encoded = encodeURIComponent(tag);
    return scope === 'mine' ? `/app/tags/${encoded}?scope=mine` : `/app/tags/${encoded}`;
  }

  function cacheKey(nextScope: Scope): string {
    return `deepmarks-tags:${nextScope}:v1`;
  }

  function loadCachedCounts(nextScope: Scope): TagCount[] {
    if (!browser) return [];
    try {
      const raw = localStorage.getItem(cacheKey(nextScope));
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

  function saveCachedCounts(nextScope: Scope, counts: TagCount[]): void {
    if (!browser) return;
    try {
      localStorage.setItem(cacheKey(nextScope), JSON.stringify(counts));
    } catch {
      // Quota/private mode: live tags still render.
    }
  }

  function primeDisplayedCounts(nextScope: Scope): void {
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
    displayedScope = nextScope;
    displayedCounts = loadCachedCounts(nextScope);
    lastSnapshotSignature = '';
  }

  function signatureFor(nextScope: Scope, counts: TagCount[]): string {
    return `${nextScope}:${counts.map((t) => `${t.name}:${t.count}`).join('|')}`;
  }

  function scheduleSnapshot(nextScope: Scope, counts: TagCount[]): void {
    if (displayedScope !== nextScope) primeDisplayedCounts(nextScope);
    const signature = signatureFor(nextScope, counts);
    if (signature === lastSnapshotSignature) return;
    lastSnapshotSignature = signature;

    if (snapshotTimer) clearTimeout(snapshotTimer);
    if (counts.length === 0) {
      if (displayedCounts.length === 0) displayedCounts = [];
      return;
    }
    snapshotTimer = setTimeout(() => {
      if (scope !== nextScope || lastSnapshotSignature !== signature) return;
      displayedScope = nextScope;
      displayedCounts = counts;
      saveCachedCounts(nextScope, counts);
      snapshotTimer = null;
    }, TAG_SNAPSHOT_DELAY_MS);
  }
</script>

<svelte:head><title>{scope === 'mine' ? 'my tags' : 'tags'} — Deepmarks</title></svelte:head>

<div class="container">
  <div class="toolbar">
    <div class="segments">
      <button type="button" on:click={() => setScope('mine')} class:active={scope === 'mine'}>my tags</button>
      <button type="button" on:click={() => setScope('network')} class:active={scope === 'network'}>network tags</button>
    </div>
    <div class="segments">
      <button type="button" on:click={() => setView('list')} class:active={view === 'list'}>list</button>
      <button type="button" on:click={() => setView('cloud')} class:active={view === 'cloud'}>tag cloud</button>
    </div>
  </div>

  <h1>{scope === 'mine' ? 'my tags' : 'popular tags'}</h1>

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
