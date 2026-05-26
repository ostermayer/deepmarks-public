<script lang="ts">
  import FeedIconLink from './FeedIconLink.svelte';

  // Sort items are click-handlers, not links. The old shape had each
  // sort as `{label, href}` but every consumer pointed at `#` because
  // the sorts mutate page-local state, not navigation. Now each sort
  // takes an `id` and an optional `onSelect` callback. Backwards-
  // compatible: callers can still pass href-style entries for purely
  // navigational subheaders.
  export let context: string = '';
  export let sorts: Array<{
    label: string;
    id?: string;
    href?: string;
    current?: boolean;
  }> = [];
  export let onSort: ((id: string) => void) | undefined = undefined;
  export let feedUrl: string = '';
  export let feedLabel: string = 'Deepmarks feed';
</script>

<div class="subheader">
  {#if context}<strong class="context">{context}</strong>{/if}
  {#if sorts.length > 0}
    <span class="sort-label">sort:</span>
    <span class="sort-list">
      {#each sorts as s, i}
        {#if i > 0}<span class="sep">|</span>{/if}
        {#if s.current}
          <strong>{s.label}</strong>
        {:else if s.id && onSort}
          <button type="button" class="sort-btn" on:click={() => onSort?.(s.id!)}>{s.label}</button>
        {:else}
          <a href={s.href ?? '#'}>{s.label}</a>
        {/if}
      {/each}
    </span>
  {/if}
  {#if feedUrl}
    <span class="feed-slot">
      <FeedIconLink href={feedUrl} label={feedLabel} />
    </span>
  {/if}
</div>

<style>
  .subheader {
    position: sticky;
    top: var(--app-sticky-top, 0px);
    z-index: 27;
    background: var(--paper-warm);
    /* Left padding matches the nav/search-bar indent in Header.svelte
       (.header 24px + .nav padding-left 38px = 62px from the viewport)
       so the content column stays flush with the wordmark + nav tabs. */
    padding: 9px 24px 9px 62px;
    border-bottom: 1px solid var(--rule);
    font-size: 12px;
    color: var(--muted);
    display: flex;
    flex-wrap: nowrap;
    align-items: baseline;
    gap: 16px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    white-space: nowrap;
    box-shadow: 0 1px 0 var(--rule);
  }
  :global(.section-nav) + .subheader {
    top: calc(var(--app-sticky-top, 0px) + var(--app-section-nav-height, 45px));
    z-index: 26;
  }
  .subheader::-webkit-scrollbar {
    display: none;
  }
  @media (max-width: 720px) {
    .subheader {
      padding: 8px 16px;
      gap: 12px;
    }
  }
  .subheader strong {
    color: var(--ink);
  }
  .subheader a {
    color: var(--link);
  }
  .sort-label {
    color: var(--muted);
  }
  .sort-list {
    display: inline-flex;
    align-items: baseline;
    gap: 10px;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .sep {
    color: var(--rule);
  }
  .sort-btn {
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--link);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .sort-btn:hover { color: var(--coral); text-decoration: underline; }
  .feed-slot {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
  }
</style>
