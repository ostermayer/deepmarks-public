<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { derived, writable, type Readable } from 'svelte/store';
  import { browser } from '$app/environment';
  import Logo from '$lib/components/Logo.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import LandingFeedRow from '$lib/components/LandingFeedRow.svelte';
  import { isNativeShell, nativePlatform } from '$lib/native/runtime';
  import { config } from '$lib/config';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import { rankByPopularity, tallyReceiptsInWindow, type RankedBookmark } from '$lib/nostr/popularity';
  import { createZapReceiptFeed } from '$lib/nostr/zap-counts';
  import { compareBookmarksNewest, type ParsedBookmark } from '$lib/nostr/bookmarks';
  import { currentSession, session } from '$lib/stores/session';
  import { APP_LINKS } from '$lib/app-links';
  import { EXTENSION_LINKS } from '$lib/extension-links';
  import type { PublicBookmark } from '$lib/api/client';

  let nativeShell = isNativeShell();
  let platform = nativePlatform();
  const nativeMode = writable(nativeShell);
  let showAuthChoices = nativeShell;

  // Logged-in users skip the marketing landing and go straight to their bookmarks.
  // We key off the persisted hint (available synchronously on boot) rather
  // than waiting for the signer to rehydrate, so the redirect fires on the
  // first paint instead of flashing the landing briefly.
  onMount(() => {
    let cancelled = false;
    nativeShell = isNativeShell();
    platform = nativePlatform();
    nativeMode.set(nativeShell);
    if (isNativeShell()) {
      showAuthChoices = true;
      void (async () => {
        await session.rehydrate();
        if (currentSession().pubkey) void goto('/app/bookmarks', { replaceState: true });
      })();
      return () => { cancelled = true; };
    }
    if (session.hint) {
      void goto('/app/bookmarks', { replaceState: true });
      return () => { cancelled = true; };
    }
    void (async () => {
      const {
        consumeDeepmarksAutoLoginSuppression,
        waitForDeepmarksExtension,
      } = await import('$lib/nostr/extension-autologin');
      if (consumeDeepmarksAutoLoginSuppression()) {
        if (!cancelled) showAuthChoices = true;
        return;
      }
      if (await waitForDeepmarksExtension()) {
        void goto('/app/bookmarks?source=extension', { replaceState: true });
        return;
      }
      if (!cancelled) showAuthChoices = true;
    })();
    return () => { cancelled = true; };
  });

  // Until organic activity catches up, the landing page only shows events
  // from the Deepmarks daily Pinboard/public-profile identity. The broader
  // /app/network and /app/recent feeds remain unfiltered.
  // If the seeder pubkey is unset, we subscribe to nothing rather than
  // accidentally showing arbitrary public Nostr activity on the home page.
  const landingFeed = config.landingFeedPubkeys.length > 0
    ? createBookmarkFeed({ authors: config.landingFeedPubkeys, limit: 200 })
    : createBookmarkFeed({ authors: ['__none__'], limit: 0 });
  const networkFeed = createBookmarkFeed({ limit: 200 });
  const indexedLandingFeed = writable<ParsedBookmark[]>([]);

  onMount(() => {
    if (config.landingFeedPubkeys.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const { api } = await import('$lib/api/client');
        const results = await Promise.allSettled(
          config.landingFeedPubkeys.map((pubkey) => api.publicBookmarks(pubkey, 100)),
        );
        if (cancelled) return;
        const bookmarks = results
          .flatMap((result) => result.status === 'fulfilled' ? result.value.bookmarks : [])
          .map(publicBookmarkToParsed)
          .sort(compareBookmarksNewest);
        indexedLandingFeed.set(bookmarks);
      } catch {
        // Relay-backed feeds continue to load; this is only a first-paint fallback.
      }
    })();
    return () => { cancelled = true; };
  });

  const RECENT_LIMIT = 8;
  const POPULAR_LIMIT = 8;

  // Live zap-receipt feed. Tallied all-time on the landing page — the
  // time-window selector lives on /app/popular, not on the marketing
  // home rails.
  const receipts = createZapReceiptFeed();

  const feed: Readable<ParsedBookmark[]> = derived(
    [landingFeed, networkFeed, indexedLandingFeed, nativeMode],
    ([$landing, $network, $indexed, $native]) => {
      if ($native) return $network.length > 0 ? $network : $indexed;
      return $landing.length > 0 ? $landing : $indexed;
    },
  );
  const recentSource: Readable<ParsedBookmark[]> = derived(feed, ($f) => $f.slice(0, RECENT_LIMIT));
  const popularSource: Readable<RankedBookmark[]> = derived([feed, receipts], ([$f, $r]) =>
    rankByPopularity($f, tallyReceiptsInWindow($r, 0)).slice(0, POPULAR_LIMIT),
  );

  // localStorage cache so the rails feel instant on revisit instead of
  // showing "no items" → items flowing in
  // → a "↑ N new" banner. Cache holds the last snapshot we showed; live
  // data overwrites it silently as it arrives.
  const RECENT_CACHE_KEY = 'deepmarks-landing-recent';
  const POPULAR_CACHE_KEY = 'deepmarks-landing-popular';

  function readCache<T>(key: string): T[] {
    if (!browser) return [];
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T[]) : [];
    } catch {
      return [];
    }
  }

  function writeCache<T>(key: string, items: T[]): void {
    if (!browser) return;
    try {
      localStorage.setItem(key, JSON.stringify(items));
    } catch {
      // Quota exceeded / private mode — non-fatal, just no cache.
    }
  }

  const recent = writable<ParsedBookmark[]>(readCache<ParsedBookmark>(RECENT_CACHE_KEY));
  const popular = writable<RankedBookmark[]>(readCache<RankedBookmark>(POPULAR_CACHE_KEY));

  const unsubRecent = recentSource.subscribe((val) => {
    if (val.length > 0) {
      recent.set(val);
      writeCache(RECENT_CACHE_KEY, val);
    }
  });
  const unsubPopular = popularSource.subscribe((val) => {
    if (val.length > 0) {
      popular.set(val);
      writeCache(POPULAR_CACHE_KEY, val);
    }
  });

  onDestroy(() => {
    unsubRecent();
    unsubPopular();
  });

  function publicBookmarkToParsed(bookmark: PublicBookmark): ParsedBookmark {
    return {
      url: bookmark.url,
      title: bookmark.title || bookmark.url,
      description: bookmark.description,
      tags: bookmark.tags,
      blossomHash: bookmark.blossomHash,
      waybackUrl: bookmark.waybackUrl,
      archivedForever: bookmark.archivedForever,
      publishedAt: bookmark.publishedAt,
      savedAt: bookmark.savedAt,
      eventCreatedAt: bookmark.eventCreatedAt,
      curator: bookmark.pubkey,
      eventId: bookmark.id,
    };
  }
</script>

<svelte:head>
  <title>Deepmarks — bookmarks for the open web</title>
</svelte:head>

<main
  class="home-shell"
  class:native={nativeShell}
  class:android={platform === 'android'}
  data-native-scroll-root={platform === 'android' ? 'true' : undefined}
>
  <header class="hero" class:native={nativeShell}>
    <div class="brand">
      <Logo size={24} />
      <h1>Deepmarks</h1>
      <p class="tagline">bookmarks for the open web</p>
    </div>
  </header>

  {#if showAuthChoices}
    <section class="auth-row" class:native={nativeShell}>
      <a class="pixel-btn primary" href="/login">log in</a>
      <a class="pixel-btn" href="/signup">sign up</a>
    </section>
  {:else if !nativeShell}
    <section class="auth-row pending" aria-live="polite">
      <span>checking signer...</span>
    </section>
  {/if}

  {#if !nativeShell}
    <section class="extension-row" aria-label="apps and browser extensions">
      <a
        href={APP_LINKS.ios}
        target="_blank"
        rel="noreferrer"
      >ios</a>
      <span class="coming-soon">android</span>
      <a
        href={EXTENSION_LINKS.chrome}
        target="_blank"
        rel="noreferrer"
      >chrome</a>
      <a
        href={EXTENSION_LINKS.firefox}
        target="_blank"
        rel="noreferrer"
      >firefox</a>
    </section>

    <section class="features">
      <a class="pixel-card block" href="/pricing#duplicated-worldwide">
        <span>duplicated worldwide</span>
      </a>
      <a class="pixel-card block" href="/pricing#archive-forever">
        <span>website archiving</span>
      </a>
      <a class="pixel-card block" href="/pricing#tip-great-links">
        <span>tip great links</span>
      </a>
      <a class="pixel-card block" href="/pricing#import-export">
        <span>import and export easily</span>
      </a>
    </section>
  {/if}

  <section class="live" class:native={nativeShell}>
    <div class="live-col">
      <div class="col-head">
        <h3>recent</h3>
        <a href="/app/recent">all →</a>
      </div>
      {#if $recent.length === 0}
        <div class="empty">no items</div>
      {:else}
        {#each $recent as b (b.eventId)}
          <LandingFeedRow bookmark={b} />
        {/each}
      {/if}
    </div>

    <div class="live-col">
      <div class="col-head">
        <h3>popular</h3>
        <a href="/app/popular">all →</a>
      </div>
      {#if $popular.length === 0}
        <div class="empty">loading popular bookmarks...</div>
      {:else}
        {#each $popular as b (b.eventId)}
          <LandingFeedRow bookmark={b} saveCount={b.saveCount} />
        {/each}
      {/if}
    </div>
  </section>

  {#if !nativeShell}
    <Footer />
  {/if}
</main>

<style>
  .home-shell {
    background: var(--paper);
  }
  .home-shell.android {
    height: 100vh;
    height: 100dvh;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior-y: auto;
    touch-action: pan-y;
    -webkit-overflow-scrolling: touch;
  }
  .hero {
    max-width: 1040px;
    margin: 0 auto;
    padding: 80px 24px 40px;
    text-align: center;
  }
  .hero.native {
    padding: calc(env(safe-area-inset-top, 0px) + 24px) 20px 12px;
  }
  .brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  h1 {
    /* font-family + weight come from .wordmark-retro */
    font-size: 26px;
    line-height: 1;
    font-weight: 600;
    color: var(--ink-deep);
    margin: 0;
  }
  .tagline {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.15;
    margin: 0;
  }
  .auth-row {
    width: min(100%, 340px);
    margin: 60px auto 14px;
    padding: 0 24px;
    box-sizing: border-box;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 20px;
    justify-content: center;
  }
  .auth-row.native {
    margin: 14px auto 22px;
    padding: 0 20px;
    gap: 10px;
  }
  .auth-row.native a {
    min-width: 0;
    flex: 1;
    max-width: 180px;
  }
  .auth-row a {
    min-width: 0;
    text-align: center;
  }
  .auth-row.pending {
    color: var(--muted);
    font-size: 13px;
    margin-top: 28px;
    margin-bottom: 42px;
  }
  .extension-row {
    width: min(100%, 340px);
    margin: 0 auto 50px;
    padding: 0 24px;
    box-sizing: border-box;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    justify-content: center;
    align-items: center;
    gap: 8px 20px;
    color: var(--muted);
    font-size: 12px;
  }
  .extension-row a,
  .extension-row .coming-soon {
    color: var(--coral-deep);
    border: 1px solid var(--rule);
    border-radius: 999px;
    padding: 5px 12px;
    text-decoration: none;
    background: var(--surface);
  }
  .extension-row .coming-soon {
    color: var(--muted);
  }
  .extension-row a:hover {
    border-color: var(--coral);
    text-decoration: none;
  }
  .features {
    max-width: 640px;
    margin: 0 auto;
    padding: 0 24px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }
  .block {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    padding: 20px 22px;
    min-height: 96px;
    color: var(--ink-deep) !important;
    text-decoration: none;
  }
  .block span {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.2px;
    line-height: 1.2;
  }
  .block:hover {
    text-decoration: none;
  }
  @media (max-width: 520px) {
    .hero {
      padding: 48px 20px 22px;
    }
    .auth-row {
      width: min(100%, 320px);
      margin: 22px auto 12px;
      gap: 12px;
    }
    .extension-row {
      width: min(100%, 320px);
      margin: 0 auto 34px;
      padding: 0 20px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 12px;
    }
    .extension-row a,
    .extension-row .coming-soon {
      text-align: center;
      padding: 6px 9px;
    }
    .features {
      grid-template-columns: 1fr;
    }
  }
  .live {
    max-width: 1040px;
    margin: 56px auto 60px;
    padding: 0 24px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 36px;
  }
  .live.native {
    margin: 0 auto calc(84px + env(safe-area-inset-bottom, 0px));
    padding: 0 16px;
    grid-template-columns: 1fr;
    gap: 22px;
  }
  .live.native .live-col {
    border-top: 1px solid var(--rule);
    padding-top: 8px;
  }
  .live-col {
    min-width: 0;
  }
  .col-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--rule);
  }
  .col-head h3 {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--muted);
    letter-spacing: 1.5px;
    margin: 0;
    font-weight: 600;
  }
  .col-head a {
    font-size: 11px;
    color: var(--link);
  }
  .empty {
    padding: 24px 0;
    color: var(--muted);
    font-size: 12px;
    text-align: center;
  }
  @media (max-width: 720px) {
    .live {
      grid-template-columns: 1fr;
      gap: 28px;
    }
  }
</style>
