<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import Logo from './Logo.svelte';
  import Avatar from './Avatar.svelte';
  import LifetimeBadge from './LifetimeBadge.svelte';
  import { session, npub } from '$lib/stores/session';
  import { theme, type Theme } from '$lib/stores/theme';
  import { getProfile } from '$lib/nostr/profiles';
  import { readable, type Readable } from 'svelte/store';
  import type { Profile } from '$lib/nostr/profiles';

  // Stable empty store so `$profile` always resolves even when signed out.
  const EMPTY_PROFILE: Readable<Profile | null> = readable(null);

  export let showNav: boolean = true;

  let menuOpen = false;
  let searchInput: HTMLInputElement | null = null;
  let menuRoot: HTMLDivElement | null = null;
  let query = '';

  function onSubmitSearch(e: Event) {
    e.preventDefault();
    if (!query.trim()) return;
    void goto(`/app/search?q=${encodeURIComponent(query.trim())}`);
  }

  function onGlobalKey(e: KeyboardEvent) {
    if (e.key !== '/') return;
    const target = e.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
    e.preventDefault();
    searchInput?.focus();
  }

  function onClickOutside(e: MouseEvent) {
    if (!menuRoot) return;
    if (!menuRoot.contains(e.target as Node)) menuOpen = false;
  }

  function pickTheme(next: Theme) {
    theme.set(next);
    menuOpen = false;
  }

  function logout() {
    session.logout();
    menuOpen = false;
    void goto('/');
  }

  onMount(() => {
    document.addEventListener('keydown', onGlobalKey);
    document.addEventListener('click', onClickOutside);
  });
  onDestroy(() => {
    if (typeof document === 'undefined') return;
    document.removeEventListener('keydown', onGlobalKey);
    document.removeEventListener('click', onClickOutside);
  });

  $: currentTheme = $theme;
  $: shortNpub = $npub ? `${$npub.slice(0, 12)}…${$npub.slice(-5)}` : '';
  // Reactively swap the profile store whenever the signed-in pubkey changes.
  $: profile = $session.pubkey ? getProfile($session.pubkey) : EMPTY_PROFILE;
  $: pathname = $page.url.pathname;
  $: isActive = (href: string) =>
    href === '/app' ? pathname === '/app' : pathname.startsWith(href);
</script>

<div class="header">
  <div class="masthead">
    <a href="/" class="masthead-link" aria-label="Deepmarks home">
      <Logo />
    </a>
    <div class="title-block">
      <a href="/" class="wordmark">Deepmarks</a>
      <div class="tagline">bookmarks for the open web</div>
    </div>
  </div>

  <form class="header-search" on:submit={onSubmitSearch}>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
      <circle cx="7" cy="7" r="5" />
      <path d="M11 11l3 3" />
    </svg>
    <input
      bind:this={searchInput}
      bind:value={query}
      type="text"
      placeholder="search your bookmarks + the network..."
      aria-label="search"
    />
    <span class="shortcut">/</span>
  </form>

  <div class="user-info" bind:this={menuRoot}>
    {#if $session.pubkey}
      <button
        class="avatar-btn"
        type="button"
        aria-label="profile menu"
        aria-expanded={menuOpen}
        on:click={() => (menuOpen = !menuOpen)}
      >
        <span class="avatar-wrap">
          <Avatar pubkey={$session.pubkey} size={34} />
          <span class="lifetime-overlay"><LifetimeBadge pubkey={$session.pubkey} size={12} /></span>
        </span>
        {#if !$session.signer}
          <span class="avatar-lock" title="signer not connected — sign in again to publish">🔒</span>
        {/if}
      </button>
      <div class="profile-menu" class:open={menuOpen}>
        <div class="menu-header">
          <span class="avatar-wrap">
            <Avatar pubkey={$session.pubkey} size={36} />
            <span class="lifetime-overlay"><LifetimeBadge pubkey={$session.pubkey} size={13} /></span>
          </span>
          <div class="menu-identity">
            <div class="menu-name">{$profile?.displayName ?? 'your profile'}</div>
            <div class="menu-npub">{shortNpub}</div>
          </div>
        </div>
        {#if $npub}
          <a href={`/u/${$npub}`} class="menu-item" on:click={() => (menuOpen = false)}>view public profile</a>
        {/if}
        <a href="/app/archives" class="menu-item" on:click={() => (menuOpen = false)}>my archives</a>
        <a href="/app/settings" class="menu-item" on:click={() => (menuOpen = false)}>settings</a>
        <a href="/app/import" class="menu-item" on:click={() => (menuOpen = false)}>import bookmarks</a>
        <a href="/app/export" class="menu-item" on:click={() => (menuOpen = false)}>export bookmarks</a>
        <div class="menu-sep"></div>
        <button class="menu-item theme-row" type="button" on:click={() => pickTheme('light')}
          ><span>light</span>{#if currentTheme === 'light'}<span aria-hidden="true">●</span>{/if}</button
        >
        <button class="menu-item theme-row" type="button" on:click={() => pickTheme('dark')}
          ><span>dark</span>{#if currentTheme === 'dark'}<span aria-hidden="true">●</span>{/if}</button
        >
        <button class="menu-item theme-row" type="button" on:click={() => pickTheme('auto')}
          ><span>follow system</span>{#if currentTheme === 'auto'}<span aria-hidden="true">●</span>{/if}</button
        >
        <div class="menu-sep"></div>
        <button class="menu-item" type="button" on:click={logout}>logout</button>
      </div>
    {:else}
      <a href="/login" class="signin-link">sign in</a>
    {/if}
  </div>

  <!-- Top nav removed: it duplicated semantics with the in-page sort
       row + the new Global panel in the right sidebar. /app/follows,
       /app/popular, /app/recent, /app/tags routes still exist for
       direct-URL access; they're reached now from the sidebar's
       Global panel and the user's profile rather than the chrome. -->
</div>

<style>
  .header {
    padding: 32px 24px 16px;
    position: relative;
  }
  .masthead {
    display: flex;
    align-items: flex-start;
    gap: 14px;
  }
  .masthead-link {
    display: block;
    margin-top: 2px;
    line-height: 0;
  }
  .title-block {
    line-height: 1.15;
  }
  .wordmark {
    font-family: 'Space Grotesk', Inter, -apple-system, sans-serif;
    font-size: 30px;
    letter-spacing: -0.6px;
    font-weight: 600;
    line-height: 1;
    color: var(--ink-deep);
    white-space: nowrap;
    display: block;
    text-decoration: none;
  }
  .wordmark:hover {
    text-decoration: none;
  }
  .tagline {
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 13px;
    color: var(--muted);
    margin-top: 5px;
    font-weight: 400;
    letter-spacing: 0.1px;
  }
  .nav {
    font-size: 13px;
    padding-left: 38px;
    margin-top: 14px;
  }
  .nav a {
    margin-right: 20px;
    color: var(--link);
    padding-bottom: 2px;
  }
  .nav a:hover {
    border-bottom: 2px solid var(--coral);
    text-decoration: none;
    padding-bottom: 0;
  }
  .nav a.active {
    color: var(--ink-deep);
    border-bottom: 2px solid var(--coral);
    padding-bottom: 0;
    font-weight: 600;
  }
  .header-search {
    margin-top: 14px;
    margin-left: 38px;
    margin-right: 180px;
    max-width: 480px;
    display: flex;
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 100px;
    padding: 2px 4px 2px 14px;
    gap: 8px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .header-search:focus-within {
    border-color: var(--coral);
    box-shadow: 0 0 0 3px var(--coral-soft);
  }
  .header-search svg {
    width: 14px;
    height: 14px;
    color: var(--muted);
    flex-shrink: 0;
  }
  .header-search input {
    flex: 1;
    border: 0;
    background: transparent;
    outline: none;
    font-family: 'Courier New', monospace;
    font-size: 13px;
    color: var(--ink-deep);
    padding: 8px 4px;
  }
  .header-search .shortcut {
    font-size: 10px;
    background: var(--paper-warm);
    color: var(--muted);
    padding: 2px 7px;
    border-radius: 100px;
    font-family: 'Courier New', monospace;
    margin-right: 4px;
  }
  @media (max-width: 720px) {
    .header-search {
      margin-right: 0;
      max-width: none;
    }
  }
  .user-info {
    position: absolute;
    top: 30px;
    right: 24px;
  }
  .avatar-btn {
    border-radius: 50%;
    border: 1px solid var(--rule);
    background: transparent;
    cursor: pointer;
    transition: border-color 0.15s, transform 0.15s;
    padding: 0;
    position: relative;
    line-height: 0;
  }
  .avatar-btn:hover {
    border-color: var(--coral);
  }
  .avatar-wrap {
    position: relative;
    display: inline-block;
    line-height: 0;
  }
  .lifetime-overlay {
    position: absolute;
    right: -4px;
    bottom: -4px;
    background: var(--paper);
    border-radius: 100%;
    padding: 1px;
    line-height: 0;
    box-shadow: 0 0 0 1px var(--rule);
  }
  .avatar-lock {
    position: absolute;
    bottom: -2px;
    right: -2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--zap);
    border: 2px solid var(--paper);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
  }
  .signin-link {
    display: inline-block;
    background: var(--coral);
    color: var(--on-coral) !important;
    padding: 6px 14px;
    border-radius: 100px;
    font-size: 12px;
    font-weight: 500;
  }
  .signin-link:hover {
    background: var(--coral-deep);
    text-decoration: none;
  }
  .profile-menu {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    width: 240px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 10px;
    box-shadow: 0 8px 24px var(--shadow);
    padding: 6px;
    opacity: 0;
    visibility: hidden;
    transform: translateY(-4px);
    transition: opacity 0.15s, transform 0.15s, visibility 0.15s;
    z-index: 10;
  }
  .profile-menu.open {
    opacity: 1;
    visibility: visible;
    transform: translateY(0);
  }
  .profile-menu::before {
    content: '';
    position: absolute;
    top: -6px;
    right: 12px;
    width: 12px;
    height: 12px;
    background: var(--surface);
    border-left: 1px solid var(--rule);
    border-top: 1px solid var(--rule);
    transform: rotate(45deg);
  }
  .menu-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 10px 12px;
    border-bottom: 1px solid var(--rule);
    margin-bottom: 4px;
  }
  .menu-identity .menu-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--ink-deep);
    line-height: 1.2;
  }
  .menu-identity .menu-npub {
    font-size: 10px;
    color: var(--muted);
    font-family: 'Courier New', monospace;
    margin-top: 2px;
  }
  .menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 10px;
    color: var(--ink) !important;
    border-radius: 6px;
    font-size: 13px;
    text-decoration: none;
    cursor: pointer;
    background: none;
    border: 0;
    width: 100%;
    text-align: left;
    font-family: inherit;
  }
  .menu-item:hover {
    background: var(--paper-warm);
    text-decoration: none;
  }
  .menu-sep {
    height: 1px;
    background: var(--rule);
    margin: 4px 0;
  }
  .theme-row {
    color: var(--muted) !important;
  }

  /* ── Mobile breakpoints ──────────────────────────────────────────
     The desktop layout assumes ~720px+ horizontal space (sidebar
     rail + main column + masthead). Below that we collapse:
       - tighter padding so content gets more pixels
       - nav scrolls horizontally instead of wrapping into multiple
         visually-busy rows
       - header-search drops the cmd-K shortcut chip and the right
         margin (the avatar still sits at top: 30 right: 16)
       - wordmark shrinks; tagline hides under 480px (the lede on
         the home page already covers it)
  */
  @media (max-width: 720px) {
    .header { padding: 18px 16px 12px; }
    .wordmark { font-size: 24px; }
    .tagline { font-size: 12px; }
    .nav {
      padding-left: 0;
      margin-top: 12px;
      overflow-x: auto;
      white-space: nowrap;
      -webkit-overflow-scrolling: touch;
    }
    .nav a { margin-right: 16px; }
    .header-search {
      margin-left: 0;
      margin-right: 0;
      max-width: none;
    }
    .user-info { top: 18px; right: 16px; }
  }
  @media (max-width: 480px) {
    .tagline { display: none; }
    .header-search .shortcut { display: none; }
  }
</style>
