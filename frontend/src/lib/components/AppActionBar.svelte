<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { OVERLAY_RESULT_CAP, type SearchResultItem } from '$lib/search/search-result';

  interface SearchScopeOption {
    id: string;
    label: string;
    checked: boolean;
  }

  export let addOpen = false;
  export let searchOpen = false;
  export let searchQuery = '';
  export let searchPlaceholder = 'search...';
  export let searchScopes: SearchScopeOption[] = [];
  export let resultSummary = '';
  export let addDisabled = false;
  export let searchDisabled = false;
  export let compact = false;
  export let hasExtraActions = false;
  export let panelOnly = false;
  // Live matches for the current query, already filtered + ordered by the
  // host page. Rendered inside the overlay; Enter opens the selected row.
  // null = this page hasn't opted into in-overlay results, so the panel
  // stays input-only (its list filters behind the overlay as before).
  export let searchResults: SearchResultItem[] | null = null;
  // Offer a "search the network" escape hatch to the full /app/search page.
  export let networkSearch = true;

  const dispatch = createEventDispatcher<{
    toggleAdd: void;
    toggleSearch: void;
    scope: { id: string; checked: boolean };
  }>();

  $: showAddControl = !addDisabled;
  $: showSearchControl = !searchDisabled;
  $: showSearchPanel = searchOpen && showSearchControl;
  $: showActionBar = panelOnly
    ? false
    : showAddControl || showSearchControl || !!resultSummary || showSearchPanel || hasExtraActions;

  let searchInput: HTMLInputElement | null = null;
  let searchPanel: HTMLDivElement | null = null;
  let lastFocusedElement: HTMLElement | null = null;
  let focusedOpenState = false;
  let resultEls: HTMLAnchorElement[] = [];
  let networkEl: HTMLAnchorElement | null = null;
  let selectedIndex = 0;
  let lastSelectionQuery = '';

  $: trimmedQuery = searchQuery.trim();
  $: hasQuery = trimmedQuery.length > 0;
  $: liveResults = searchResults !== null;
  $: totalResults = searchResults?.length ?? 0;
  $: visibleResults = (searchResults ?? []).slice(0, OVERLAY_RESULT_CAP);
  $: networkHref = `/app/search?q=${encodeURIComponent(trimmedQuery)}&global=1`;
  // Reset the highlight to the top each time the query text changes; clamp
  // it in range as results shrink between keystrokes.
  $: if (searchQuery !== lastSelectionQuery) {
    lastSelectionQuery = searchQuery;
    selectedIndex = 0;
  }
  $: if (selectedIndex > 0 && selectedIndex >= visibleResults.length) {
    selectedIndex = Math.max(0, visibleResults.length - 1);
  }

  $: if (showSearchPanel && !focusedOpenState) {
    focusedOpenState = true;
    lastFocusedElement = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    void focusSearchInput();
  }
  $: if (!showSearchPanel && focusedOpenState) focusedOpenState = false;

  onMount(() => {
    document.addEventListener('keydown', onDocumentKeydown);
  });

  onDestroy(() => {
    document.removeEventListener('keydown', onDocumentKeydown);
  });

  async function focusSearchInput(): Promise<void> {
    await tick();
    searchInput?.focus();
    searchInput?.select();
  }

  function closeSearch(): void {
    searchOpen = false;
    const restoreTarget = lastFocusedElement;
    lastFocusedElement = null;
    void tick().then(() => restoreTarget?.focus());
  }

  // Enter opens the highlighted match (a real anchor, so it inherits the
  // same new-tab / native link handling as a bookmark click). With no
  // matches, Enter escalates to the full network search instead of the old
  // behavior of silently closing and discarding the query.
  function openSelected(): void {
    const row = resultEls[selectedIndex];
    if (row) {
      row.click();
      closeSearch();
      return;
    }
    if (hasQuery && networkSearch) networkEl?.click();
  }

  function moveSelection(delta: number): void {
    if (visibleResults.length === 0) return;
    selectedIndex = Math.min(
      Math.max(selectedIndex + delta, 0),
      visibleResults.length - 1,
    );
    resultEls[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function onSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
    }
  }

  function onDocumentKeydown(event: KeyboardEvent): void {
    if (showSearchPanel && event.key === 'Escape') {
      event.preventDefault();
      closeSearch();
      return;
    }
    if (!showSearchControl) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      searchOpen = true;
    }
  }

  function onPanelKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(searchPanel?.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((node) => !node.hasAttribute('disabled') && node.tabIndex >= 0);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

{#if showActionBar}
  <div class="action-bar" class:compact>
    {#if !panelOnly}
      <div class="action-buttons">
        {#if showAddControl}
          <button
            type="button"
            class:active={addOpen}
            aria-expanded={addOpen}
            on:click={() => dispatch('toggleAdd')}
          >
            + add a bookmark
          </button>
        {/if}
        {#if showSearchControl}
          <button
            type="button"
            class:active={searchOpen}
            aria-expanded={searchOpen}
            on:click={() => dispatch('toggleSearch')}
          >
            search
          </button>
        {/if}
        {#if resultSummary}
          <span class="summary">{resultSummary}</span>
        {/if}
        <slot name="actions" />
      </div>
    {/if}

  </div>
{/if}

{#if showSearchPanel}
  <div
    class="search-overlay"
    role="presentation"
    on:pointerdown={(event) => {
      if (event.target === event.currentTarget) closeSearch();
    }}
  >
    <div
      bind:this={searchPanel}
      class="search-panel"
      role="dialog"
      aria-modal="true"
      aria-label="search"
      tabindex="-1"
      on:keydown={onPanelKeydown}
    >
      <form on:submit|preventDefault={openSelected}>
        <div class="search-row">
          <input
            bind:this={searchInput}
            type="search"
            placeholder={searchPlaceholder}
            bind:value={searchQuery}
            on:keydown={onSearchKeydown}
            autocomplete="off"
            spellcheck="false"
            role="combobox"
            aria-expanded={liveResults && hasQuery}
            aria-controls="action-bar-search-results"
            aria-activedescendant={visibleResults.length > 0 ? `action-bar-result-${selectedIndex}` : undefined}
          />
          <button type="button" class="close-search" aria-label="close search" on:click={closeSearch}>
            ×
          </button>
        </div>
        {#if searchScopes.length > 0}
          <div class="scope-row">
            {#each searchScopes as scope}
              <label>
                <input
                  type="checkbox"
                  checked={scope.checked}
                  on:change={(event) => dispatch('scope', {
                    id: scope.id,
                    checked: (event.currentTarget as HTMLInputElement).checked,
                  })}
                />
                <span>{scope.label}</span>
              </label>
            {/each}
          </div>
        {/if}
      </form>

      {#if liveResults && hasQuery}
        {#if visibleResults.length > 0}
          <ul id="action-bar-search-results" class="results" role="listbox" aria-label="search results">
            {#each visibleResults as item, i (item.id)}
              <li role="presentation">
                <a
                  bind:this={resultEls[i]}
                  id={`action-bar-result-${i}`}
                  class="result-row"
                  class:selected={i === selectedIndex}
                  role="option"
                  aria-selected={i === selectedIndex}
                  href={item.href}
                  target={item.external === false ? undefined : '_blank'}
                  rel={item.external === false ? undefined : 'noreferrer'}
                  tabindex="-1"
                  on:mouseenter={() => (selectedIndex = i)}
                  on:click={closeSearch}
                >
                  <span class="result-title">{item.title}</span>
                  {#if item.subtitle}<span class="result-sub">{item.subtitle}</span>{/if}
                </a>
              </li>
            {/each}
          </ul>
          {#if totalResults > visibleResults.length}
            <p class="results-more">showing first {visibleResults.length} of {totalResults.toLocaleString()} matches</p>
          {/if}
        {:else}
          <p class="no-results">no matches for <code>{trimmedQuery}</code> here</p>
        {/if}

        <div class="search-foot">
          <div class="hints">
            <span><kbd>↑</kbd><kbd>↓</kbd> select</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>esc</kbd> close</span>
          </div>
          {#if networkSearch}
            <a class="network-link" bind:this={networkEl} href={networkHref} on:click={closeSearch}>
              search the network →
            </a>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .action-bar {
    background: var(--paper);
    border-bottom: 0;
    padding: 12px 24px 6px 62px;
  }
  .action-buttons {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  button {
    border: 1px solid var(--rule);
    background: var(--surface);
    color: var(--link);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    border-radius: 999px;
    padding: 7px 12px;
    cursor: pointer;
  }
  button:hover {
    border-color: var(--coral);
    color: var(--coral-deep);
  }
  button.active {
    background: var(--coral-soft);
    border-color: var(--coral);
    color: var(--coral-deep);
  }
  .summary {
    color: var(--muted);
    font-size: 12px;
  }
  .search-overlay {
    position: fixed;
    inset: 0;
    z-index: 120;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: clamp(64px, 12vh, 120px) 18px 18px;
    background: color-mix(in srgb, var(--paper) 72%, transparent);
    backdrop-filter: blur(2px);
  }
  .search-panel {
    width: min(720px, 100%);
    max-height: calc(100vh - 96px);
    overflow: auto;
    padding: 12px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: 0 18px 45px var(--shadow);
  }
  .search-panel form {
    display: grid;
    gap: 10px;
  }
  .search-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 38px;
    gap: 8px;
    align-items: center;
  }
  input[type='search'] {
    width: 100%;
    height: 42px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-size: 15px;
    padding: 0 12px;
  }
  input[type='search']:focus {
    outline: 2px solid var(--coral-soft);
    border-color: var(--coral);
  }
  .close-search {
    width: 38px;
    height: 38px;
    border-radius: 8px;
    padding: 0;
    font-size: 20px;
    line-height: 1;
  }
  .scope-row {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    color: var(--muted);
    font-size: 12px;
  }
  .scope-row label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .scope-row input {
    width: 14px;
    height: 14px;
    accent-color: var(--coral);
  }
  .results {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    border-top: 1px solid var(--rule);
  }
  .result-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 9px 10px;
    border-radius: 8px;
    text-decoration: none;
    color: var(--ink-deep);
    cursor: pointer;
  }
  .result-row:hover {
    text-decoration: none;
  }
  .result-row.selected {
    background: var(--coral-soft);
  }
  .result-title {
    font-size: 14px;
    font-weight: 600;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .result-row.selected .result-title {
    color: var(--coral-deep);
  }
  .result-sub {
    font-size: 11px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .results-more {
    margin: 8px 2px 0;
    color: var(--muted);
    font-size: 11px;
  }
  .no-results {
    margin: 12px 2px 2px;
    color: var(--muted);
    font-size: 13px;
  }
  .no-results code {
    background: var(--paper-warm);
    padding: 1px 6px;
    border-radius: 4px;
    font-family: 'Courier New', monospace;
    font-size: 12px;
  }
  .search-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--rule);
  }
  .hints {
    display: flex;
    align-items: center;
    gap: 14px;
    color: var(--muted);
    font-size: 11px;
  }
  .hints span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    border: 1px solid var(--rule);
    border-radius: 4px;
    background: var(--paper-warm);
    color: var(--ink);
    font-family: 'Courier New', monospace;
    font-size: 11px;
    line-height: 1;
  }
  .network-link {
    color: var(--link);
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
    white-space: nowrap;
  }
  .network-link:hover {
    color: var(--coral-deep);
  }
  @media (max-width: 720px) {
    .action-bar {
      padding: 10px 16px;
    }
    .search-overlay {
      padding-top: calc(18px + env(safe-area-inset-top, 0px));
    }
  }
  .action-bar.compact {
    padding: 10px 0;
    border-bottom: 0;
  }
</style>
