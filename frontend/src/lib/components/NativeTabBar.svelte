<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { Archive, Bookmark, Plus, Search, Settings } from 'lucide-svelte';
  import { isNativeShell } from '$lib/native/runtime';

  let nativeShell = isNativeShell();

  const tabs = [
    { label: 'bookmarks', href: '/app/bookmarks', icon: Bookmark, match: (path: string) => path.startsWith('/app/bookmarks') },
    { label: 'search', href: '/app/search', icon: Search, match: (path: string) => path.startsWith('/app/search') },
    { label: 'save', href: '/app/save', icon: Plus, match: (path: string) => path.startsWith('/app/save') },
    { label: 'archives', href: '/app/archives', icon: Archive, match: (path: string) => path.startsWith('/app/archives') },
    { label: 'settings', href: '/app/settings', icon: Settings, match: (path: string) => path.startsWith('/app/settings') },
  ];

  onMount(() => {
    nativeShell = isNativeShell();
  });

  $: pathname = $page.url.pathname;
</script>

{#if nativeShell}
  <nav class="native-tabbar" aria-label="primary">
    {#each tabs as tab}
      <a
        href={tab.href}
        class:active={tab.match(pathname)}
        aria-current={tab.match(pathname) ? 'page' : undefined}
      >
        <svelte:component this={tab.icon} size={20} strokeWidth={2.1} />
        <span>{tab.label}</span>
      </a>
    {/each}
  </nav>
{/if}

<style>
  .native-tabbar {
    --native-tabbar-item-height: 54px;
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    /* With contentInset: 'never' iOS no longer applies the safe-area
       inset for us, so the bar takes care of it: 60px of items at the
       top, plus env(safe-area-inset-bottom) of home-indicator clearance
       at the bottom. Total bar height adapts to the device, but the
       VISIBLE item row above the home indicator is always 60px. */
    height: calc(60px + env(safe-area-inset-bottom, 0px));
    min-height: calc(60px + env(safe-area-inset-bottom, 0px));
    max-height: calc(60px + env(safe-area-inset-bottom, 0px));
    box-sizing: border-box;
    overflow: hidden;
    z-index: 40;
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    grid-auto-rows: var(--native-tabbar-item-height);
    align-content: start;
    align-items: start;
    gap: 0;
    padding: 6px 6px calc(env(safe-area-inset-bottom, 0px) + 0px);
    background: color-mix(in srgb, var(--paper) 94%, transparent);
    border-top: 1px solid var(--rule);
    box-shadow: 0 -6px 18px rgba(0, 0, 0, 0.08);
    backdrop-filter: blur(16px);
  }
  .native-tabbar a {
    min-width: 0;
    max-width: 100%;
    height: var(--native-tabbar-item-height);
    min-height: var(--native-tabbar-item-height);
    max-height: var(--native-tabbar-item-height);
    box-sizing: border-box;
    border-radius: 8px;
    color: var(--muted);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    text-decoration: none;
    font-size: 10px !important;
    line-height: 1.05 !important;
    font-weight: 600;
    white-space: nowrap;
  }
  .native-tabbar a span {
    display: block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .native-tabbar a.active {
    color: var(--link);
    background: var(--paper-warm);
  }
  .native-tabbar a:hover {
    text-decoration: none;
  }
  .native-tabbar :global(svg) {
    display: block;
  }
</style>
