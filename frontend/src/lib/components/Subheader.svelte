<script lang="ts">
  import { ArrowDown, ArrowDownAZ, ArrowDownZA, ArrowUp, Zap } from 'lucide-svelte';
  import FeedIconLink from './FeedIconLink.svelte';

  type IconComponent = typeof ArrowDown;

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

  function sortIcon(id?: string): IconComponent | null {
    if (id === 'newest') return ArrowDown;
    if (id === 'oldest') return ArrowUp;
    if (id === 'title-az') return ArrowDownAZ;
    if (id === 'title-za') return ArrowDownZA;
    if (id === 'zap-sats') return Zap;
    return null;
  }

  function compactSortLabel(label: string): string {
    if (label === 'title a-z') return 'A-Z';
    if (label === 'title z-a') return 'Z-A';
    return label;
  }
</script>

<div class="subheader">
  <span class="subheader-main">
    {#if context}<strong class="context">{context}</strong>{/if}
    {#if sorts.length > 0}
      <span class="sort-label">sort:</span>
      <span class="sort-list">
        {#each sorts as s}
          {@const Icon = sortIcon(s.id)}
          {#if s.id && onSort}
            <button
              type="button"
              class="sort-btn"
              class:active={s.current}
              class:icon-sort={!!Icon}
              class:text-sort={!Icon}
              aria-label={`sort ${s.label}`}
              aria-pressed={s.current}
              title={`sort ${s.label}`}
              on:click={() => onSort?.(s.id!)}
            >
              {#if Icon}
                <svelte:component this={Icon} size={16} strokeWidth={2.2} />
                <span class="sr-only">{s.label}</span>
              {:else}
                <span>{compactSortLabel(s.label)}</span>
              {/if}
            </button>
          {:else if s.current}
            <strong class="nav-current">{compactSortLabel(s.label)}</strong>
          {:else}
            <a href={s.href ?? '#'}>{compactSortLabel(s.label)}</a>
          {/if}
        {/each}
      </span>
    {/if}
  </span>
  <span class="subheader-right">
    {#if feedUrl}
      <span class="feed-slot">
        <FeedIconLink href={feedUrl} label={feedLabel} />
      </span>
    {/if}
    <slot name="actions" />
  </span>
</div>

<style>
  .subheader {
    position: sticky;
    top: var(--app-sticky-top, 0px);
    z-index: 27;
    background: color-mix(in srgb, var(--paper-warm) 66%, var(--paper));
    /* Left padding matches the nav/search-bar indent in Header.svelte
       (.header 24px + .nav padding-left 38px = 62px from the viewport)
       so the content column stays flush with the wordmark + nav tabs. */
    padding: 9px 24px 9px 62px;
    border-bottom: 0;
    font-size: 12px;
    color: var(--muted);
    display: grid;
    grid-template-columns: minmax(0, 1160px) minmax(240px, 320px);
    justify-content: space-between;
    align-items: center;
    gap: 8px 16px;
    overflow: visible;
    scrollbar-width: none;
    white-space: normal;
    box-shadow: 0 1px 0 color-mix(in srgb, var(--rule) 55%, transparent);
  }
  :global(.section-nav) + .subheader {
    top: calc(var(--app-sticky-top, 0px) + var(--app-section-nav-height, 45px));
    z-index: 26;
  }
  :global(html.native-shell) .subheader,
  :global(body.native-shell) .subheader {
    top: var(--app-sticky-top, 0px);
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
  .subheader-main,
  .subheader-right {
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 8px 16px;
  }
  .subheader-main {
    flex-wrap: wrap;
  }
  .subheader-right {
    justify-self: stretch;
    justify-content: flex-end;
  }
  .subheader a {
    color: var(--link);
  }
  .nav-current {
    display: inline-flex;
    align-items: center;
    min-height: 30px;
  }
  .sort-label {
    color: var(--muted);
  }
  .sort-list {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .sort-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 30px;
    height: 30px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 8px;
    padding: 0;
    color: var(--link);
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .sort-btn.text-sort {
    min-width: 42px;
    padding: 0 8px;
  }
  .sort-btn.active {
    background: var(--paper);
    border-color: color-mix(in srgb, var(--link) 34%, var(--rule));
    color: var(--ink-deep);
  }
  .sort-btn :global(svg) {
    display: block;
    width: 16px;
    height: 16px;
  }
  .sort-btn:hover {
    border-color: var(--coral);
    color: var(--coral-deep);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .feed-slot {
    display: inline-flex;
    align-items: center;
  }
  @media (max-width: 720px) {
    .subheader {
      grid-template-columns: 1fr;
    }
    .subheader-right {
      width: 100%;
      justify-content: flex-end;
    }
    /* In the native app the "add a bookmark" button is hidden (the
       bottom tab bar's "save" replaces it), so subheader-right holds
       only the small search/feed icons. Keep them on the sort row
       instead of dropping to a full-width second line. */
    :global(html.native-shell) .subheader,
    :global(body.native-shell) .subheader {
      grid-template-columns: 1fr auto;
    }
    :global(html.native-shell) .subheader-right,
    :global(body.native-shell) .subheader-right {
      width: auto;
    }
  }
</style>
