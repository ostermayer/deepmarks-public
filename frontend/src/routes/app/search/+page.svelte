<script lang="ts">
  // Search defaults to the signed-in user's local library so private
  // bookmarks and freshly imported rows are searchable immediately.
  // Public network matches can render as a secondary right rail so the
  // main workflow stays "find my bookmark" while still offering discovery.

  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { config } from '$lib/config';
  import Subheader from '$lib/components/Subheader.svelte';
  import LandingFeedRow from '$lib/components/LandingFeedRow.svelte';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { ownBookmarks } from '$lib/stores/own-bookmarks';
  import { session } from '$lib/stores/session';
  import { searchLocalBookmarks } from '$lib/search/local-bookmark-search';

  interface Hit {
    event_id: string;
    score: number;
    doc: {
      id: string;
      url: string;
      title: string;
      description: string;
      tags: string[];
      author_pubkey: string;
      domain: string;
      created_at: number;
      zap_total: number;
      save_count: number;
    };
  }

  let hits: Hit[] = [];
  let total = 0;
  let queryTimeMs = 0;
  let loading = false;
  let error: string | null = null;
  let searchToken = 0;
  const PAGE_SIZE = 50;
  const GLOBAL_LIMIT = 12;
  let visibleLimit = PAGE_SIZE;
  let lastSearchKey = '';
  let lastGlobalQuery = '';

  $: query = ($page.url.searchParams.get('q') ?? '').trim();
  $: globalSearch = $page.url.searchParams.get('global') === '1';
  $: searchKey = query;
  $: if (searchKey !== lastSearchKey) {
    visibleLimit = PAGE_SIZE;
    lastSearchKey = searchKey;
  }
  $: localResults = query
    ? searchLocalBookmarks($ownBookmarks, query, { limit: 10_000 })
    : [];
  $: visibleLocalResults = localResults.slice(0, visibleLimit);
  $: localHasMore = visibleLimit < localResults.length;
  $: globalResults = hits
    .filter((h) => h.doc.author_pubkey !== $session.pubkey)
    .slice(0, GLOBAL_LIMIT);
  $: if (query && globalSearch && query !== lastGlobalQuery) {
    lastGlobalQuery = query;
    void runGlobalSearch(query);
  }
  $: if (!query || !globalSearch) {
    lastGlobalQuery = '';
    hits = [];
    total = 0;
    queryTimeMs = 0;
    loading = false;
    error = null;
  }

  function setGlobalSearch(enabled: boolean): void {
    const params = new URLSearchParams($page.url.searchParams);
    if (enabled) params.set('global', '1');
    else params.delete('global');
    const qs = params.toString();
    void goto(`/app/search${qs ? `?${qs}` : ''}`, {
      replaceState: true,
      noScroll: true,
      keepFocus: true,
    });
  }

  async function runGlobalSearch(q: string): Promise<void> {
    const token = ++searchToken;
    loading = true;
    error = null;
    try {
      const res = await fetch(
        `${config.apiBase}/search/public?q=${encodeURIComponent(q)}&limit=50`,
      );
      if (!res.ok) throw new Error(`search ${res.status}`);
      const json = (await res.json()) as { hits: Hit[]; total: number; query_time_ms: number };
      if (token !== searchToken || !globalSearch || q !== query) return;
      hits = json.hits;
      total = json.total;
      queryTimeMs = json.query_time_ms;
    } catch (e) {
      if (token !== searchToken || !globalSearch || q !== query) return;
      error = (e as Error).message ?? 'search failed';
    } finally {
      if (token === searchToken && globalSearch && q === query) loading = false;
    }
  }

  function hitToBookmark(h: Hit): ParsedBookmark {
    return {
      url: h.doc.url,
      title: h.doc.title || h.doc.url,
      description: h.doc.description,
      tags: h.doc.tags ?? [],
      archivedForever: false,
      savedAt: h.doc.created_at,
      curator: h.doc.author_pubkey,
      eventId: h.event_id,
    };
  }

</script>

<svelte:head><title>{query ? `${query} — search` : 'search'} — Deepmarks</title></svelte:head>

<Subheader context={query ? `search · "${query}"` : 'search'} />

<div class="search-controls">
  <label class="scope-toggle">
    <input
      type="checkbox"
      checked={globalSearch}
      on:change={(event) => setGlobalSearch((event.currentTarget as HTMLInputElement).checked)}
    />
    <span>include global results</span>
  </label>
</div>

{#if !query}
  <div class="hint">
    <p>Search your bookmarks by title, description, URL, or tag. Public network matches appear alongside your results.</p>
    <ul>
      <li><code>#bitcoin</code> — restrict to a tag</li>
      <li><code>site:paulgraham.com</code> — restrict to a host</li>
      <li><code>after:2024-01-01</code> · <code>before:2024-12-31</code> — date range</li>
    </ul>
  </div>
{:else}
  <div class="search-layout" class:with-global={globalSearch}>
    <section class="primary-results" aria-label="your bookmarks">
      <div class="section-head">
        <h2>your bookmarks</h2>
        {#if localResults.length > 0}
          <span>{localResults.length.toLocaleString()} {localResults.length === 1 ? 'match' : 'matches'}</span>
        {/if}
      </div>

      {#if localResults.length === 0}
        <p class="empty">no matches in your bookmarks for <code>{query}</code></p>
      {:else}
        <div class="results">
          {#each visibleLocalResults as bookmark (bookmark.eventId)}
            <LandingFeedRow {bookmark} />
          {/each}
          {#if localHasMore}
            <div class="load-more-wrap">
              <button type="button" class="load-more" on:click={() => { visibleLimit = Math.min(visibleLimit + PAGE_SIZE, localResults.length); }}>
                load more
              </button>
              <span>showing {Math.min(visibleLimit, localResults.length).toLocaleString()} of {localResults.length.toLocaleString()}</span>
            </div>
          {/if}
        </div>
      {/if}
    </section>

    {#if globalSearch}
      <aside class="global-results" aria-label="global results">
        <div class="section-head">
          <h2>global results</h2>
          {#if total > 0 && !loading && !error}
            <span>{total.toLocaleString()} public · {queryTimeMs} ms</span>
          {:else}
            <span>public bookmarks</span>
          {/if}
        </div>

        {#if loading}
          <p class="empty">searching…</p>
        {:else if error}
          <p class="empty err">couldn't search — {error}</p>
        {:else if globalResults.length === 0}
          <p class="empty">no other public matches for <code>{query}</code></p>
        {:else}
          <div class="global-list">
            {#each globalResults as h (h.event_id)}
              <LandingFeedRow bookmark={hitToBookmark(h)} saveCount={h.doc.save_count} />
            {/each}
          </div>
        {/if}
      </aside>
    {/if}
  </div>
{/if}

<style>
  .search-controls {
    max-width: 1180px;
    margin: 0 auto;
    padding: 14px 24px 0;
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--ink);
    font-size: 13px;
  }
  .scope-toggle {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--ink-deep);
    cursor: pointer;
  }
  .hint {
    max-width: 1040px;
    margin: 0 auto;
    padding: 24px;
    color: var(--ink);
  }
  .hint code { background: var(--paper-warm); padding: 1px 6px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; }
  ul { line-height: 1.9; padding-left: 20px; }
  .search-layout {
    max-width: 1180px;
    margin: 0 auto;
    padding: 20px 24px 60px;
  }
  .search-layout.with-global {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
    gap: 34px;
    align-items: start;
  }
  .primary-results,
  .global-results {
    min-width: 0;
  }
  .global-results {
    border-left: 1px solid var(--rule);
    padding-left: 24px;
  }
  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--rule);
    margin-bottom: 2px;
  }
  .section-head h2 {
    margin: 0;
    font-size: 11px;
    line-height: 1.2;
    font-weight: 700;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--ink-deep);
  }
  .section-head span {
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
  }
  .empty {
    margin: 0;
    padding: 32px 0;
    color: var(--muted);
    font-size: 13px;
  }
  .empty code {
    background: var(--paper-warm);
    padding: 1px 6px;
    border-radius: 4px;
    font-family: 'Courier New', monospace;
    font-size: 12px;
  }
  .empty.err { color: var(--coral-deep); }
  .global-list :global(.row) {
    gap: 8px;
    padding: 9px 0;
  }
  .global-list :global(.row > .favicon) {
    width: 18px;
    height: 18px;
  }
  .global-list :global(.title) {
    font-size: 12px;
  }
  .global-list :global(.meta) {
    font-size: 10px;
    gap: 4px;
  }
  .global-list :global(.save-link),
  .global-list :global(.saved-tag) {
    padding: 3px 8px;
    font-size: 10px;
  }
  .load-more-wrap {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 12px;
    margin: 18px 0 8px;
    color: var(--muted);
    font-size: 12px;
  }
  .load-more {
    border: 1px solid var(--rule);
    background: var(--surface);
    color: var(--link);
    border-radius: 999px;
    padding: 8px 14px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .load-more:hover {
    border-color: var(--coral);
    color: var(--coral-deep);
  }
  @media (max-width: 720px) {
    .search-layout {
      display: block;
      padding: 18px 20px 48px;
    }
    .global-results {
      border-left: 0;
      border-top: 1px solid var(--rule);
      padding-left: 0;
      padding-top: 22px;
      margin-top: 28px;
    }
    .section-head {
      align-items: flex-start;
      flex-direction: column;
      gap: 4px;
    }
    .load-more-wrap {
      flex-direction: column;
      gap: 8px;
    }
  }
</style>
