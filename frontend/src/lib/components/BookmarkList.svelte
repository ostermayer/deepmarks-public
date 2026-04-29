<script lang="ts">
  // Shared list shell — every feed page (network, recent, popular, your-marks,
  // tags/[tag], search) renders the same flex container + sidebar.
  //
  // Sidebar data is derived from the list itself: the tag cloud aggregates
  // tags from the visible bookmarks, and stats are shown only when the
  // caller passes `showStats={true}` (typically only on /app, the "your
  // marks" view). Pages that need different sidebar behaviour can override
  // `showStats` or wrap Sidebar directly.

  import { onDestroy, onMount } from 'svelte';
  import BookmarkCard from './BookmarkCard.svelte';
  import Sidebar from './Sidebar.svelte';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { tagCloudFrom, type TagCloudItem } from '$lib/nostr/tag-cloud';
  import { userStatsFrom } from '$lib/nostr/user-stats';
  import { getNdk } from '$lib/nostr/ndk';

  export let bookmarks: ParsedBookmark[] = [];
  export let loading: boolean = false;
  export let emptyMessage: string = 'no bookmarks yet';
  /** Set true when `bookmarks` is the user's own feed (drives the stats panel). */
  export let showStats: boolean = false;
  /**
   * Freeze both the tag cloud AND the rendered bookmark list shortly after
   * the first batch of events settles, so the page doesn't reshuffle
   * underneath the reader as relays keep streaming. New events land in a
   * "N new — show" banner that, when clicked, flushes them into the
   * visible list and re-freezes.
   *
   * Default ON — every public feed wants this. Pass false on flows where
   * live streaming IS the feature (the user's own just-saved list).
   */
  export let freezeFeed: boolean = true;

  // Tag-cloud snapshot is derived from whichever bookmark list is currently
  // displayed, so freezing the list implicitly freezes the cloud too.
  // The separate freezeTagCloud flag is retained here only because older
  // pages pass it — it's a no-op now that freezeFeed handles both.
  export let freezeTagCloud: boolean = false;
  void freezeTagCloud; // accepted but superseded by freezeFeed

  const FREEZE_DELAY_MS = 800;
  let frozenList: ParsedBookmark[] | null = null;
  let frozenCloud: TagCloudItem[] | null = null;
  let freezeTimer: ReturnType<typeof setTimeout> | null = null;

  $: if (freezeFeed && !frozenList && !freezeTimer && bookmarks.length > 0) {
    freezeTimer = setTimeout(() => {
      frozenList = [...bookmarks];
      frozenCloud = tagCloudFrom(bookmarks);
    }, FREEZE_DELAY_MS);
  }

  onDestroy(() => {
    if (freezeTimer) clearTimeout(freezeTimer);
    if (relayPollTimer) clearInterval(relayPollTimer);
  });

  /** How many bookmarks have arrived since we froze that aren't in the
   *  current snapshot. Surfaced as the banner count. */
  $: pendingCount = frozenList
    ? bookmarks.filter((b) => !frozenList!.some((f) => f.eventId === b.eventId)).length
    : 0;

  $: displayedBookmarks = frozenList ?? bookmarks;
  $: tagCloud = frozenCloud ?? tagCloudFrom(bookmarks);
  $: stats = showStats ? userStatsFrom(bookmarks) : null;

  // Live NDK relay-status snapshot. Each NDKRelay's connectivity.status
  // is 1 when the WebSocket is open. Polled at 2s intervals because
  // NDKRelay doesn't emit a Svelte-friendly store, but the status
  // changes are slow + the diff is cheap. Surfaces in the Sidebar's
  // "relays" panel so a user with "loading is slow" can see at a
  // glance whether they're connected to any relays at all.
  let relayStatus: { url: string; ok: boolean }[] = [];
  let relayPollTimer: ReturnType<typeof setInterval> | null = null;
  function snapshotRelays(): { url: string; ok: boolean }[] {
    try {
      const pool = getNdk().pool;
      return [...pool.relays.values()].map((r) => ({
        url: r.url,
        ok: r.connectivity?.status === 1,
      }));
    } catch {
      return [];
    }
  }
  onMount(() => {
    relayStatus = snapshotRelays();
    relayPollTimer = setInterval(() => { relayStatus = snapshotRelays(); }, 2000);
  });

  function showPending() {
    frozenList = [...bookmarks];
    frozenCloud = tagCloudFrom(bookmarks);
  }
</script>

<div class="container">
  <div class="main">
    <slot name="prepend" />

    {#if pendingCount > 0}
      <button type="button" class="pending-banner" on:click={showPending}>
        ↑ {pendingCount} new bookmark{pendingCount === 1 ? '' : 's'} — show
      </button>
    {/if}

    {#if loading && displayedBookmarks.length === 0}
      <div class="empty">listening to relays…</div>
    {:else if displayedBookmarks.length === 0}
      <div class="empty">{emptyMessage}</div>
    {:else}
      {#each displayedBookmarks as b (b.eventId)}
        <BookmarkCard bookmark={b} />
      {/each}
    {/if}

    <slot name="append" />
  </div>

  <Sidebar {tagCloud} {stats} {showStats} relays={relayStatus} />
</div>

<style>
  .container {
    display: flex;
    padding: 24px;
    gap: 36px;
  }
  .main {
    flex: 1;
    min-width: 0;
  }
  .empty {
    padding: 60px 0;
    text-align: center;
    color: var(--muted);
  }
  .pending-banner {
    display: block;
    width: 100%;
    margin: 0 0 12px;
    padding: 8px 14px;
    background: var(--coral-soft);
    color: var(--coral-deep);
    border: 1px solid var(--coral);
    border-radius: 100px;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    text-align: center;
  }
  .pending-banner:hover { background: var(--coral); color: var(--on-coral); }
  @media (max-width: 720px) {
    .container {
      flex-direction: column;
      gap: 28px;
      padding: 20px;
    }
  }
</style>
