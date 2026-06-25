<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';

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

  const dispatch = createEventDispatcher<{
    toggleAdd: void;
    toggleSearch: void;
    submitSearch: { query: string };
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

  function submitSearch(): void {
    dispatch('submitSearch', { query: searchQuery.trim() });
    closeSearch();
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
      <form on:submit|preventDefault={submitSearch}>
        <div class="search-row">
          <input
            bind:this={searchInput}
            type="search"
            placeholder={searchPlaceholder}
            bind:value={searchQuery}
            autocomplete="off"
            spellcheck="false"
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
