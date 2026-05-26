<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import {
    Bookmark,
    BookOpen,
    Check,
    ChevronDown,
    ChevronUp,
    Compass,
    EllipsisVertical,
    FileText,
    Plus,
    Search,
    Settings,
    Tags,
    Users,
  } from 'lucide-svelte';
  import { isNativeShell } from '$lib/native/runtime';

  type IconComponent = typeof Bookmark;
  type TabId = 'bookmarks' | 'friends' | 'search' | 'save' | 'tags' | 'posts' | 'readlater';

  interface NavItem {
    id: string;
    label: string;
    href: string;
    icon: IconComponent;
    match: (route: string) => boolean;
  }

  const STORAGE_KEY = 'deepmarks-native-tabbar:v1';
  const MIN_VISIBLE_TABS = 3;
  const DEFAULT_VISIBLE_IDS: TabId[] = ['bookmarks', 'friends', 'search', 'save', 'tags'];

  let nativeShell = isNativeShell();
  let optimisticHref = '';
  let moreOpen = false;
  let customizing = false;
  let visibleTabIds: TabId[] = [...DEFAULT_VISIBLE_IDS];
  let draftVisibleTabIds: TabId[] = [...DEFAULT_VISIBLE_IDS];
  let morePressTimer: number | null = null;
  let suppressNextMoreClick = false;

  const appTabs: Array<NavItem & { id: TabId }> = [
    {
      id: 'bookmarks',
      label: 'bookmarks',
      href: '/app/bookmarks',
      icon: Bookmark,
      match: (route) => route.startsWith('/app/bookmarks') && !route.includes('view=readlater'),
    },
    { id: 'friends', label: 'friends', href: '/app/friends', icon: Users, match: (route) => route.startsWith('/app/friends') },
    { id: 'search', label: 'search', href: '/app/search', icon: Search, match: (route) => route.startsWith('/app/search') },
    { id: 'save', label: 'save', href: '/app/save', icon: Plus, match: (route) => route.startsWith('/app/save') },
    { id: 'tags', label: 'tags', href: '/app/tags?view=list', icon: Tags, match: (route) => route.startsWith('/app/tags') },
    { id: 'posts', label: 'posts', href: '/app/posts', icon: FileText, match: (route) => route.startsWith('/app/posts') },
    {
      id: 'readlater',
      label: 'read later',
      href: '/app/bookmarks?view=readlater',
      icon: BookOpen,
      match: (route) => route.startsWith('/app/bookmarks') && route.includes('view=readlater'),
    },
  ];

  const secondaryItems: NavItem[] = [
    {
      id: 'explore',
      label: 'explore',
      href: '/app/explore',
      icon: Compass,
      match: (route) => route.startsWith('/app/explore') || route.startsWith('/app/recent') || route.startsWith('/app/popular'),
    },
    { id: 'settings', label: 'settings', href: '/app/settings', icon: Settings, match: (route) => route.startsWith('/app/settings') },
  ];

  const tabById = new Map<TabId, NavItem & { id: TabId }>(appTabs.map((tab) => [tab.id, tab]));

  onMount(() => {
    nativeShell = isNativeShell();
    visibleTabIds = loadVisibleTabIds();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      moreOpen = false;
      customizing = false;
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      clearMorePressTimer();
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  $: currentHref = `${$page.url.pathname}${$page.url.search}`;
  $: if (optimisticHref && currentHref === optimisticHref) optimisticHref = '';
  $: activeRoute = optimisticHref || currentHref;
  $: visibleTabs = visibleTabIds.map((id) => tabById.get(id)).filter(Boolean) as Array<NavItem & { id: TabId }>;
  $: hiddenAppTabs = appTabs.filter((tab) => !visibleTabIds.includes(tab.id));
  $: moreItems = [...hiddenAppTabs, ...secondaryItems];
  $: draftVisibleTabs = draftVisibleTabIds.map((id) => tabById.get(id)).filter(Boolean) as Array<NavItem & { id: TabId }>;
  $: draftHiddenAppTabs = appTabs.filter((tab) => !draftVisibleTabIds.includes(tab.id));
  $: customizeRows = [...draftVisibleTabs, ...draftHiddenAppTabs];
  $: moreActive = moreItems.some((item) => item.match(activeRoute));
  $: tabCount = visibleTabs.length + 1;
  $: denseTabs = tabCount > 6;

  function onTabClick(event: MouseEvent, href: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (currentHref === href) return;
    moreOpen = false;
    customizing = false;
    optimisticHref = href;
    void goto(href, { keepFocus: true });
  }

  function toggleMore(event: MouseEvent): void {
    event.preventDefault();
    if (suppressNextMoreClick) {
      suppressNextMoreClick = false;
      return;
    }
    moreOpen = !moreOpen;
    customizing = false;
  }

  function startMorePress(): void {
    clearMorePressTimer();
    morePressTimer = window.setTimeout(() => {
      morePressTimer = null;
      suppressNextMoreClick = true;
      openCustomize();
    }, 550);
  }

  function clearMorePressTimer(): void {
    if (!morePressTimer) return;
    window.clearTimeout(morePressTimer);
    morePressTimer = null;
  }

  function openCustomize(): void {
    moreOpen = false;
    draftVisibleTabIds = [...visibleTabIds];
    customizing = true;
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate?.(10);
    }
  }

  function closeOverlays(): void {
    moreOpen = false;
    customizing = false;
    draftVisibleTabIds = [...visibleTabIds];
  }

  function toggleDraftTab(id: TabId): void {
    if (draftVisibleTabIds.includes(id)) {
      if (draftVisibleTabIds.length <= MIN_VISIBLE_TABS) return;
      draftVisibleTabIds = draftVisibleTabIds.filter((tabId) => tabId !== id);
    } else {
      draftVisibleTabIds = [...draftVisibleTabIds, id];
    }
  }

  function moveDraftTab(id: TabId, delta: -1 | 1): void {
    const index = draftVisibleTabIds.indexOf(id);
    const nextIndex = index + delta;
    if (index < 0 || nextIndex < 0 || nextIndex >= draftVisibleTabIds.length) return;
    const next = [...draftVisibleTabIds];
    const current = next[index];
    const target = next[nextIndex];
    if (!current || !target) return;
    next[index] = target;
    next[nextIndex] = current;
    draftVisibleTabIds = next;
  }

  function resetTabs(): void {
    draftVisibleTabIds = [...DEFAULT_VISIBLE_IDS];
  }

  function saveTabSelection(): void {
    visibleTabIds = [...draftVisibleTabIds];
    saveVisibleTabIds();
    customizing = false;
  }

  function loadVisibleTabIds(): TabId[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
      if (!Array.isArray(parsed)) return [...DEFAULT_VISIBLE_IDS];
      const valid = parsed.filter((id): id is TabId => tabById.has(id));
      const unique = [...new Set(valid)];
      return unique.length >= MIN_VISIBLE_TABS ? unique : [...DEFAULT_VISIBLE_IDS];
    } catch {
      return [...DEFAULT_VISIBLE_IDS];
    }
  }

  function saveVisibleTabIds(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(visibleTabIds));
    } catch {
      // Local UI preferences are non-critical.
    }
  }
</script>

{#if nativeShell}
  {#if moreOpen || customizing}
    <button
      type="button"
      class="more-scrim"
      aria-label="close menu"
      on:click={closeOverlays}
    ></button>
  {/if}

  {#if moreOpen}
    <div class="more-menu" aria-label="more sections">
      {#each moreItems as item}
        <a
          href={item.href}
          class:active={item.match(activeRoute)}
          aria-current={item.match(activeRoute) ? 'page' : undefined}
          on:click={(event) => onTabClick(event, item.href)}
        >
          <svelte:component this={item.icon} size={20} strokeWidth={2.1} />
          <span>{item.label}</span>
        </a>
      {/each}
    </div>
  {/if}

  {#if customizing}
    <section class="customize-sheet" aria-label="customize bottom tabs">
      <div class="customize-head">
        <button type="button" class="text-btn" on:click={resetTabs}>reset</button>
        <div>
          <strong>bottom tabs</strong>
          <span>{draftVisibleTabs.length} shown, minimum {MIN_VISIBLE_TABS}</span>
        </div>
        <button type="button" class="text-btn primary" on:click={saveTabSelection}>save</button>
      </div>

      <div class="customize-list">
        {#each customizeRows as tab}
          {@const selected = draftVisibleTabIds.includes(tab.id)}
          {@const index = draftVisibleTabIds.indexOf(tab.id)}
          <div class:selected class="customize-row">
            <button
              type="button"
              class="check-btn"
              aria-pressed={selected}
              aria-label={selected ? `remove ${tab.label}` : `add ${tab.label}`}
              disabled={selected && draftVisibleTabIds.length <= MIN_VISIBLE_TABS}
              on:click={() => toggleDraftTab(tab.id)}
            >
              {#if selected}<Check size={16} strokeWidth={2.4} />{/if}
            </button>
            <svelte:component this={tab.icon} size={19} strokeWidth={2.1} />
            <span>{tab.label}</span>
            <div class="reorder">
              <button
                type="button"
                aria-label={`move ${tab.label} up`}
                disabled={!selected || index <= 0}
                on:click={() => moveDraftTab(tab.id, -1)}
              >
                <ChevronUp size={17} strokeWidth={2.2} />
              </button>
              <button
                type="button"
                aria-label={`move ${tab.label} down`}
                disabled={!selected || index < 0 || index >= draftVisibleTabIds.length - 1}
                on:click={() => moveDraftTab(tab.id, 1)}
              >
                <ChevronDown size={17} strokeWidth={2.2} />
              </button>
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <nav
    class:dense={denseTabs}
    class="native-tabbar"
    aria-label="primary"
    data-sveltekit-preload-data="tap"
    style={`--tab-count: ${tabCount};`}
  >
    {#each visibleTabs as tab}
      <a
        href={tab.href}
        class:active={tab.match(activeRoute)}
        aria-current={tab.match(activeRoute) ? 'page' : undefined}
        on:click={(event) => onTabClick(event, tab.href)}
      >
        <svelte:component this={tab.icon} size={20} strokeWidth={2.1} />
        <span>{tab.label}</span>
      </a>
    {/each}
    <button
      type="button"
      class:active={moreActive || moreOpen || customizing}
      aria-expanded={moreOpen || customizing}
      aria-haspopup="menu"
      on:pointerdown={startMorePress}
      on:pointerup={clearMorePressTimer}
      on:pointerleave={clearMorePressTimer}
      on:pointercancel={clearMorePressTimer}
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
    grid-template-columns: repeat(var(--tab-count, 6), minmax(0, 1fr));
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
  .native-tabbar.dense a,
  .native-tabbar.dense button {
    font-size: 8px !important;
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
  .customize-sheet {
    position: fixed;
    left: 8px;
    right: 8px;
    bottom: calc(68px + env(safe-area-inset-bottom, 0px));
    z-index: 41;
    max-height: min(520px, calc(100dvh - 112px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)));
    overflow: auto;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: color-mix(in srgb, var(--paper) 97%, transparent);
    box-shadow: 0 16px 38px rgba(0, 0, 0, 0.18);
    backdrop-filter: blur(16px);
    padding: 12px;
  }
  .customize-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--rule);
  }
  .customize-head strong,
  .customize-head span {
    display: block;
  }
  .customize-head strong {
    color: var(--ink-deep);
    font-size: 14px;
  }
  .customize-head span {
    color: var(--muted);
    font-size: 12px;
  }
  .text-btn {
    border: 1px solid var(--rule);
    border-radius: 999px;
    background: var(--surface);
    color: var(--ink-deep);
    padding: 6px 11px;
    font: 600 12px 'Space Grotesk', Inter, sans-serif;
  }
  .text-btn.primary {
    border-color: var(--coral);
    background: var(--coral);
    color: var(--on-coral);
  }
  .customize-list {
    display: grid;
    gap: 8px;
    padding-top: 10px;
  }
  .customize-row {
    min-width: 0;
    display: grid;
    grid-template-columns: 30px 24px minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink);
    padding: 8px;
  }
  .customize-row.selected {
    color: var(--ink-deep);
    border-color: color-mix(in srgb, var(--link) 34%, var(--rule));
    background: var(--paper-warm);
  }
  .customize-row span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
  .check-btn,
  .reorder button {
    width: 30px;
    height: 30px;
    border: 1px solid var(--rule);
    border-radius: 7px;
    background: var(--paper);
    color: var(--link);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .check-btn:disabled,
  .reorder button:disabled {
    opacity: 0.35;
    color: var(--muted);
  }
  .reorder {
    display: inline-flex;
    gap: 5px;
  }
  .native-tabbar :global(svg),
  .more-menu :global(svg),
  .customize-sheet :global(svg) {
    display: block;
    width: 20px;
    height: 20px;
    flex: 0 0 20px;
  }
</style>
