<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { Bookmark, Compass, EllipsisVertical, Plus, Search, Settings, Tags, Users } from 'lucide-svelte';
  import { isNativeShell } from '$lib/native/runtime';

  let nativeShell = isNativeShell();
  let optimisticPathname = '';
  let moreOpen = false;

  const tabs = [
    { label: 'bookmarks', href: '/app/bookmarks', icon: Bookmark, match: (path: string) => path.startsWith('/app/bookmarks') },
    { label: 'friends', href: '/app/friends', icon: Users, match: (path: string) => path.startsWith('/app/friends') },
    { label: 'search', href: '/app/search', icon: Search, match: (path: string) => path.startsWith('/app/search') },
    { label: 'save', href: '/app/save', icon: Plus, match: (path: string) => path.startsWith('/app/save') },
    { label: 'tags', href: '/app/tags?view=list', icon: Tags, match: (path: string) => path.startsWith('/app/tags') },
  ];

  const moreItems = [
    { label: 'explore', href: '/app/explore', icon: Compass, match: (path: string) => path.startsWith('/app/explore') || path.startsWith('/app/recent') || path.startsWith('/app/popular') },
    { label: 'settings', href: '/app/settings', icon: Settings, match: (path: string) => path.startsWith('/app/settings') },
  ];

  onMount(() => {
    nativeShell = isNativeShell();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') moreOpen = false;
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  $: pathname = $page.url.pathname;
  $: currentHref = `${$page.url.pathname}${$page.url.search}`;
  $: if (optimisticPathname && pathname === optimisticPathname) optimisticPathname = '';
  $: activePathname = optimisticPathname || pathname;
  $: moreActive = moreItems.some((item) => item.match(activePathname));

  function onTabClick(event: MouseEvent, href: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (currentHref === href) return;
    moreOpen = false;
    optimisticPathname = new URL(href, window.location.origin).pathname;
    void goto(href, { keepFocus: true });
  }

  function toggleMore(event: MouseEvent): void {
    event.preventDefault();
    moreOpen = !moreOpen;
  }
</script>

{#if nativeShell}
  {#if moreOpen}
    <button
      type="button"
      class="more-scrim"
      aria-label="close more menu"
      on:click={() => (moreOpen = false)}
    ></button>
    <div class="more-menu" aria-label="more sections">
      {#each moreItems as item}
        <a
          href={item.href}
          class:active={item.match(activePathname)}
          aria-current={item.match(activePathname) ? 'page' : undefined}
          on:click={(event) => onTabClick(event, item.href)}
        >
          <svelte:component this={item.icon} size={20} strokeWidth={2.1} />
          <span>{item.label}</span>
        </a>
      {/each}
    </div>
  {/if}
  <nav class="native-tabbar" aria-label="primary" data-sveltekit-preload-data="tap">
    {#each tabs as tab}
      <a
        href={tab.href}
        class:active={tab.match(activePathname)}
        aria-current={tab.match(activePathname) ? 'page' : undefined}
        on:click={(event) => onTabClick(event, tab.href)}
      >
        <svelte:component this={tab.icon} size={20} strokeWidth={2.1} />
        <span>{tab.label}</span>
      </a>
    {/each}
    <button
      type="button"
      class:active={moreActive || moreOpen}
      aria-expanded={moreOpen}
      aria-haspopup="menu"
      on:click={toggleMore}
    >
      <EllipsisVertical size={20} strokeWidth={2.1} />
      <span>more</span>
    </button>
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
    grid-template-columns: repeat(6, minmax(0, 1fr));
    grid-auto-rows: var(--native-tabbar-item-height);
    align-content: start;
    align-items: start;
    gap: 0;
    padding: 6px 4px calc(env(safe-area-inset-bottom, 0px) + 0px);
    background: color-mix(in srgb, var(--paper) 94%, transparent);
    border-top: 1px solid var(--rule);
    box-shadow: 0 -6px 18px rgba(0, 0, 0, 0.08);
    backdrop-filter: blur(16px);
    transform: translateZ(0);
  }
  .native-tabbar a,
  .native-tabbar button {
    min-width: 0;
    max-width: 100%;
    height: var(--native-tabbar-item-height);
    min-height: var(--native-tabbar-item-height);
    max-height: var(--native-tabbar-item-height);
    box-sizing: border-box;
    border-radius: 8px;
    color: var(--muted);
    background: transparent;
    border: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    text-decoration: none;
    font-size: 9px !important;
    line-height: 1.05 !important;
    font-weight: 600;
    font-family: inherit;
    white-space: nowrap;
    touch-action: manipulation;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
  }
  .native-tabbar a span,
  .native-tabbar button span {
    display: block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .native-tabbar a.active,
  .native-tabbar button.active {
    color: var(--link);
    background: var(--paper-warm);
  }
  .native-tabbar a:hover,
  .native-tabbar button:hover {
    text-decoration: none;
  }
  .more-scrim {
    position: fixed;
    inset: 0;
    z-index: 39;
    border: 0;
    background: transparent;
  }
  .more-menu {
    position: fixed;
    right: 8px;
    bottom: calc(68px + env(safe-area-inset-bottom, 0px));
    z-index: 41;
    display: grid;
    grid-template-columns: repeat(2, minmax(82px, 1fr));
    gap: 8px;
    padding: 8px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: color-mix(in srgb, var(--paper) 96%, transparent);
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.16);
    backdrop-filter: blur(16px);
  }
  .more-menu a {
    min-width: 82px;
    min-height: 58px;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    border: 1px solid var(--rule);
    border-radius: 7px;
    color: var(--muted);
    text-decoration: none;
    font-size: 10px;
    font-weight: 600;
    background: var(--surface);
  }
  .more-menu a.active {
    color: var(--link);
    border-color: color-mix(in srgb, var(--link) 34%, var(--rule));
    background: var(--paper-warm);
  }
  .more-menu a:hover {
    text-decoration: none;
  }
  .native-tabbar :global(svg) {
    display: block;
  }
</style>
