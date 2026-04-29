<script lang="ts">
  import { derived, writable, type Readable } from 'svelte/store';
  import Subheader from '$lib/components/Subheader.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import { config } from '$lib/config';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import {
    applyPopularityFloor,
    rankByPopularity,
    tallyReceiptsInWindow,
    type RankedBookmark,
  } from '$lib/nostr/popularity';
  import {
    WINDOW_LABELS,
    customWindow,
    filterBookmarksByWindow,
    resolveWindow,
    type WindowKind,
    type WindowRange,
  } from '$lib/nostr/popularity-window';
  import { createZapReceiptFeed } from '$lib/nostr/zap-counts';

  // Public firehose sees only kind:39701 events — NIP-51 bookmark lists
  // (kind:10003 / 30003) live on user profile pages under the "posts"
  // tab and never aggregate into popular/recent/network. That keeps
  // personal reading-list noise out of the site-wide ranking.
  const feed = createBookmarkFeed({ limit: 200 });
  const receipts = createZapReceiptFeed();

  // Window selector. Default "all time" so existing behavior is unchanged
  // until the user picks something tighter.
  const selectedKind = writable<WindowKind>('all');
  const customSince = writable<string>(''); // YYYY-MM-DD
  const customUntil = writable<string>('');

  function computeRange(kind: WindowKind, sinceStr: string, untilStr: string): WindowRange {
    if (kind === 'custom') {
      const since = sinceStr ? new Date(`${sinceStr}T00:00:00Z`) : null;
      const until = untilStr ? new Date(`${untilStr}T23:59:59Z`) : null;
      return customWindow(since, until);
    }
    return resolveWindow(kind);
  }

  const ranked: Readable<RankedBookmark[]> = derived(
    [feed, receipts, selectedKind, customSince, customUntil],
    ([$f, $r, $kind, $since, $until]) => {
      const range = computeRange($kind, $since, $until);
      const filteredBookmarks = filterBookmarksByWindow($f, range);
      const zapData = tallyReceiptsInWindow($r, range.sinceSec, range.untilSec);
      // Two-tier floor: everything needs score >= 2 (no one-curator
      // noise), and anything not brand-seeded must have > 500 sats
      // zapped against it. Without this, the list is mostly single-
      // save junk from the broader Nostr firehose.
      return applyPopularityFloor(rankByPopularity(filteredBookmarks, zapData), {
        brandPubkey: config.deepmarksPubkey,
      });
    },
  );
</script>

<svelte:head><title>popular — Deepmarks</title></svelte:head>

<Subheader context="global · popular" />

<div class="window-bar">
  <span class="window-label">window</span>
  {#each WINDOW_LABELS as w}
    <button
      type="button"
      class:active={$selectedKind === w.kind}
      on:click={() => selectedKind.set(w.kind)}
    >
      {w.label}
    </button>
  {/each}
  <button
    type="button"
    class:active={$selectedKind === 'custom'}
    on:click={() => selectedKind.set('custom')}
  >
    custom
  </button>

  {#if $selectedKind === 'custom'}
    <span class="custom-range">
      <label>
        <span>from</span>
        <input type="date" bind:value={$customSince} />
      </label>
      <label>
        <span>to</span>
        <input type="date" bind:value={$customUntil} />
      </label>
    </span>
  {/if}
</div>

<BookmarkList bookmarks={$ranked} loading={true} freezeTagCloud={true} emptyMessage="no bookmarks in this window yet" />

<style>
  .window-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 10px 24px 10px 62px;
    border-bottom: 1px solid var(--rule);
    background: var(--paper);
    font-size: 12px;
  }
  .window-label {
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 1px;
    font-size: 10px;
    margin-right: 4px;
  }
  .window-bar button {
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 100px;
    padding: 4px 12px;
    font-size: 11px;
    color: var(--ink);
    cursor: pointer;
    font-family: inherit;
  }
  .window-bar button:hover {
    border-color: var(--coral);
    color: var(--coral);
  }
  .window-bar button.active {
    background: var(--coral);
    color: var(--on-coral);
    border-color: var(--coral);
    font-weight: 600;
  }
  .custom-range {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    margin-left: 4px;
    padding-left: 10px;
    border-left: 1px solid var(--rule);
  }
  .custom-range label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--muted);
  }
  .custom-range input {
    border: 1px solid var(--rule);
    border-radius: 6px;
    padding: 3px 6px;
    font-size: 11px;
    background: var(--surface);
    color: var(--ink);
    font-family: inherit;
  }
</style>
