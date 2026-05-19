<script lang="ts">
  import { isNativeShell } from '$lib/native/runtime';
  export let active: 'bookmarks' | 'posts' | 'readlater' | 'archives';
  export let bookmarksCount: number | null = null;
  export let postsCount: number | null = null;
  export let readLaterCount: number | null = null;
  export let archivesCount: number | null = null;
  // Native bottom tab bar already surfaces "archives". Hiding the
  // section-nav archives tab on phone widths keeps that row from
  // doubling up + frees horizontal space.
  $: showArchivesTab = !isNativeShell();
</script>

<nav class="section-nav" aria-label="Deepmarks sections">
  <a href="/app/bookmarks" class:active={active === 'bookmarks'} aria-current={active === 'bookmarks' ? 'page' : undefined}>
    bookmarks
    {#if bookmarksCount !== null}<span class="count">{bookmarksCount}</span>{/if}
  </a>
  <a href="/app/posts" class:active={active === 'posts'} aria-current={active === 'posts' ? 'page' : undefined}>
    posts
    {#if postsCount !== null}<span class="count">{postsCount}</span>{/if}
  </a>
  <a
    href="/app/bookmarks?view=readlater"
    class:active={active === 'readlater'}
    aria-current={active === 'readlater' ? 'page' : undefined}
  >
    read later
    {#if readLaterCount !== null}<span class="count">{readLaterCount}</span>{/if}
  </a>
  {#if showArchivesTab}
    <a
      href="/app/bookmarks?view=archived"
      class:active={active === 'archives'}
      aria-current={active === 'archives' ? 'page' : undefined}
    >
      archives
      {#if archivesCount !== null}<span class="count">{archivesCount}</span>{/if}
    </a>
  {/if}
</nav>

<style>
  .section-nav {
    display: flex;
    gap: 24px;
    padding: 12px 24px 12px 62px;
    border-bottom: 1px solid var(--rule);
    background: var(--paper);
  }
  .section-nav a {
    background: transparent;
    border: 0;
    padding: 4px 0;
    font-family: inherit;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0;
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    position: relative;
    text-decoration: none;
  }
  .section-nav a:hover {
    color: var(--ink);
    text-decoration: none;
  }
  .section-nav a.active {
    color: var(--ink-deep);
    font-weight: 600;
  }
  .section-nav a.active::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: -13px;
    height: 2px;
    background: var(--coral);
  }
  .count {
    font-family: 'Courier New', monospace;
    font-size: 10px;
    color: var(--muted);
    background: var(--paper-warm);
    border-radius: 100px;
    padding: 1px 7px;
    letter-spacing: 0;
    font-weight: normal;
  }
  @media (max-width: 720px) {
    .section-nav {
      padding-left: 24px;
      gap: 18px;
    }
  }
</style>
