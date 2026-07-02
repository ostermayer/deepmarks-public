<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { Plus, Search } from 'lucide-svelte';

  export let addOpen = false;
  export let searchOpen = false;
  export let resultSummary = '';
  export let addDisabled = false;
  export let searchDisabled = false;

  const dispatch = createEventDispatcher<{
    toggleAdd: void;
    toggleSearch: void;
  }>();
</script>

<span class="toolbar-actions">
  {#if resultSummary}
    <span class="summary">{resultSummary}</span>
  {/if}
  {#if !addDisabled}
    <button
      type="button"
      class="add-btn"
      class:active={addOpen}
      aria-expanded={addOpen}
      on:click={() => dispatch('toggleAdd')}
    >
      <Plus size={16} strokeWidth={2.4} />
      <span>add a bookmark</span>
    </button>
  {/if}
  <slot name="actions" />
  {#if !searchDisabled}
    <button
      type="button"
      class="icon-btn"
      class:active={searchOpen}
      aria-label="search this view"
      title="search this view"
      aria-expanded={searchOpen}
      on:click={() => dispatch('toggleSearch')}
    >
      <Search size={17} strokeWidth={2.4} />
    </button>
  {/if}
</span>

<style>
  .toolbar-actions {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    min-width: 0;
    flex-wrap: wrap;
  }
  .summary {
    color: var(--muted);
    font-size: 12px;
  }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 30px;
    border: 1px solid var(--rule);
    background: var(--surface);
    color: var(--link);
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    border-radius: 8px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
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
  .add-btn {
    padding: 0 10px;
  }
  .icon-btn {
    width: 34px;
    padding: 0;
  }
  button :global(svg) {
    flex: 0 0 auto;
  }
  @media (max-width: 720px) {
    .toolbar-actions {
      width: 100%;
    }
    .add-btn {
      flex: 1 1 auto;
      min-width: min(160px, 100%);
    }
    .icon-btn {
      flex: 0 0 36px;
    }
  }
</style>
