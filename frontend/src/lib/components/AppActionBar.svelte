<script lang="ts">
  import { createEventDispatcher } from 'svelte';

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
    scope: { id: string; checked: boolean };
  }>();

  $: showAddControl = !addDisabled;
  $: showSearchControl = !searchDisabled;
  $: showSearchPanel = searchOpen && showSearchControl;
  $: showActionBar = panelOnly
    ? showSearchPanel
    : showAddControl || showSearchControl || !!resultSummary || showSearchPanel || hasExtraActions;
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

    {#if showSearchPanel}
      <div class="search-panel">
        <input
          type="search"
          placeholder={searchPlaceholder}
          bind:value={searchQuery}
          autocomplete="off"
          spellcheck="false"
        />
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
      </div>
    {/if}
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
  .search-panel {
    margin-top: 10px;
    max-width: 720px;
    display: grid;
    gap: 8px;
  }
  input[type='search'] {
    width: 100%;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink);
    font: inherit;
    font-size: 14px;
    padding: 9px 11px;
  }
  input[type='search']:focus {
    outline: 2px solid var(--coral-soft);
    border-color: var(--coral);
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
  }
  .action-bar.compact {
    padding: 10px 0;
    border-bottom: 0;
  }
</style>
