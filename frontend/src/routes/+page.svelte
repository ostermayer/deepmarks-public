<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { derived, writable, type Readable } from 'svelte/store';
  import { browser } from '$app/environment';
  import Logo from '$lib/components/Logo.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import LandingFeedRow from '$lib/components/LandingFeedRow.svelte';
  import { config } from '$lib/config';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import { rankByPopularity, tallyReceiptsInWindow, type RankedBookmark } from '$lib/nostr/popularity';
  import { createZapReceiptFeed } from '$lib/nostr/zap-counts';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { session } from '$lib/stores/session';

  // Logged-in users skip the marketing landing and go straight to /app.
  // We key off the persisted hint (available synchronously on boot) rather
  // than waiting for the signer to rehydrate, so the redirect fires on the
  // first paint instead of flashing the landing briefly.
  onMount(() => {
    if (session.hint) void goto('/app', { replaceState: true });
  });

  // Until organic activity catches up, the landing page only shows events
  // from the deepmarks brand pubkey (the seeded Pinboard imports). The
  // broader /app/network and /app/recent feeds remain unfiltered.
  // If VITE_DEEPMARKS_PUBKEY is unset, we subscribe to nothing rather than
  // accidentally showing arbitrary public Nostr activity on the home page.
  const feed = config.deepmarksPubkey
    ? createBookmarkFeed({ authors: [config.deepmarksPubkey], limit: 200 })
    : createBookmarkFeed({ authors: ['__none__'], limit: 0 });

  const RECENT_LIMIT = 8;
  const POPULAR_LIMIT = 8;

  // Live zap-receipt feed. Tallied all-time on the landing page — the
  // time-window selector lives on /app/popular, not on the marketing
  // home rails.
  const receipts = createZapReceiptFeed();

  const recentSource: Readable<ParsedBookmark[]> = derived(feed, ($f) => $f.slice(0, RECENT_LIMIT));
  const popularSource: Readable<RankedBookmark[]> = derived([feed, receipts], ([$f, $r]) =>
    rankByPopularity($f, tallyReceiptsInWindow($r, 0)).slice(0, POPULAR_LIMIT),
  );

  // localStorage cache so the rails feel instant on revisit instead of
  // showing "listening to relays…" → empty for ~1s → items flowing in
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
</script>

<svelte:head>
  <title>Deepmarks — bookmarks for the open web</title>
</svelte:head>

<header class="hero">
  <div class="brand">
    <Logo size={42} />
    <h1>Deepmarks</h1>
    <p class="tagline">bookmarks for the open web</p>
  </div>

  <p class="lede">
    a slightly social bookmarking site where your bookmarks don't depend on us.
  </p>

</header>

<section class="features">
  <a class="pixel-card block" href="/pricing#duplicated-worldwide">
    <Logo size={20} />
    <span>duplicated worldwide</span>
  </a>
  <a class="pixel-card block" href="/pricing#archive-forever">
    <Logo size={20} />
    <span>website archiving</span>
  </a>
  <a class="pixel-card block" href="/pricing#tip-great-links">
    <Logo size={20} />
    <span>tip great links</span>
  </a>
  <a class="pixel-card block" href="/pricing#import-export">
    <Logo size={20} />
    <span>import and export easily</span>
  </a>
</section>

<section class="auth-row">
  <a class="pixel-btn primary" href="/login">log in</a>
  <a class="pixel-btn" href="/signup">sign up</a>
</section>

<section class="live">
  <div class="live-col">
    <div class="col-head">
      <h3>recent</h3>
      <a href="/app/recent">all →</a>
    </div>
    {#if $recent.length === 0}
      <div class="empty">listening to relays…</div>
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
      <div class="empty">listening to relays…</div>
    {:else}
      {#each $popular as b (b.eventId)}
        <LandingFeedRow bookmark={b} saveCount={b.saveCount} />
      {/each}
    {/if}
  </div>
</section>

<Footer />

<style>
  .hero {
    max-width: 1040px;
    margin: 0 auto;
    padding: 80px 24px 40px;
    text-align: center;
  }
  .brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  h1 {
    /* font-family + weight come from .wordmark-retro */
    font-size: 32px;
    color: var(--ink-deep);
    margin: 0;
  }
  .tagline {
    color: var(--muted);
    font-size: 16px;
    margin: 0;
  }
  .lede {
    margin: 32px auto 0;
    color: var(--ink);
    font-size: 15px;
    line-height: 1.6;
    max-width: none;
    white-space: nowrap;
  }
  @media (max-width: 720px) {
    .lede {
      font-size: 14px;
      white-space: normal;
    }
  }
  .auth-row {
    max-width: 1040px;
    margin: 60px auto;
    padding: 0 24px;
    display: flex;
    gap: 20px;
    justify-content: center;
    flex-wrap: wrap;
  }
  .auth-row a {
    min-width: 140px;
    text-align: center;
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
    justify-content: space-between;
    gap: 16px;
    padding: 20px 22px;
    min-height: 120px;
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
    .features {
      grid-template-columns: 1fr;
    }
  }
  .live {
    max-width: 1040px;
    margin: 0 auto 60px;
    padding: 0 24px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 36px;
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
