<script lang="ts">
  // Shared list shell — every feed page (network, recent, popular, your-marks,
  // tags/[tag], search) renders the same flex container + sidebar.
  //
  // Sidebar data is derived from the list itself unless callers provide a
  // summary collection. Stats are shown only when the caller passes
  // `showStats={true}` (typically only on /app, the "your marks" view).
  // Pages that need different sidebar behaviour can override `showStats`,
  // `summaryBookmarks`, or wrap Sidebar directly.

  import { onDestroy, onMount } from 'svelte';
  import BookmarkCard from './BookmarkCard.svelte';
  import NoteCard from './NoteCard.svelte';
  import Sidebar from './Sidebar.svelte';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { bookmarkZapSats } from '$lib/nostr/bookmark-zap-target';
  import { peekResolvedEvent, primeEvents, resolvedEventsVersion } from '$lib/nostr/event-resolver';
  import { extractNostrEventIdFromUrl } from '$lib/nostr/social-refs';
  import type { ZapAggregate } from '$lib/nostr/popularity';
  import { tagCloudFrom, type TagCloudItem } from '$lib/nostr/tag-cloud';
  import { userStatsFrom } from '$lib/nostr/user-stats';
  import { userSettings } from '$lib/stores/user-settings';

  export let bookmarks: ParsedBookmark[] = [];
  export let loading: boolean = false;
  export let emptyMessage: string = 'no bookmarks yet';
  /** Optional full collection for sidebar summaries when the rendered
   *  list is paged/windowed for DOM performance. */
  export let summaryBookmarks: ParsedBookmark[] | null = null;
  /** Render bookmark cards in batches to keep big accounts from locking
   *  the browser by mounting thousands of cards at once. */
  export let pageSize: number = 50;
  export let paginate: boolean = true;
  export let paginationKey: string = '';
  /** Set true when `bookmarks` is the user's own feed (drives the stats panel). */
  export let showStats: boolean = false;
  /** Optional completed-archive count for the sidebar stats panel. */
  export let archivedCountOverride: number | null = null;
  /** Optional video/audio bookmark count for the sidebar stats panel. */
  export let mediaCountOverride: number | null = null;
  /** Controls where tag links on rows and the sidebar tag cloud point. */
  export let tagScope: 'auto' | 'network' | 'mine' = 'auto';
  /** Optional zap aggregate keyed by the actual Nostr event being
   *  zapped. Friends' social-note rows use their source kind:1 id. */
  export let zapSatsByEventId: Map<string, ZapAggregate> | null = null;
  /** Friends' feed opts into richer row previews and curator avatars. */
  export let richPreviews: boolean = false;
  export let showCurator: boolean = true;
  export let showAuthorAvatars: boolean = true;
  /** Friends' feed should render Nostr note bookmarks as notes, not as
   *  generic "Nostr post" link cards. */
  export let renderNostrNoteBookmarks: boolean = false;
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
  /** Show a manual "N new bookmarks — show" banner when a frozen feed
   *  receives newer relay events. Pages that should behave like a
   *  static query result can keep the freeze without surfacing the
   *  live-update prompt. */
  export let showPendingBanner: boolean = true;

  // Tag-cloud snapshot is derived from whichever bookmark list is currently
  // displayed, so freezing the list implicitly freezes the cloud too.
  // The separate freezeTagCloud flag is retained here only because older
  // pages pass it — it's a no-op now that freezeFeed handles both.
  export let freezeTagCloud: boolean = false;
  void freezeTagCloud; // accepted but superseded by freezeFeed

  const FREEZE_DELAY_MS = 800;
  const NOTE_PRIME_WINDOW = 250;
  const TAG_CLOUD_CACHE_PREFIX = 'deepmarks-sidebar-tag-cloud:v1:';
  let frozenList: ParsedBookmark[] | null = null;
  let frozenCloud: TagCloudItem[] | null = null;
  let freezeTimer: ReturnType<typeof setTimeout> | null = null;
  let tagCloudTimer: ReturnType<typeof setTimeout> | null = null;
  let tagCloudSourceSignature = '';
  let lastFreezeKey = '';

  $: if (paginationKey !== lastFreezeKey) {
    lastFreezeKey = paginationKey;
    if (freezeTimer) {
      clearTimeout(freezeTimer);
      freezeTimer = null;
    }
    if (tagCloudTimer) {
      clearTimeout(tagCloudTimer);
      tagCloudTimer = null;
    }
    tagCloudSourceSignature = '';
    if (freezeFeed) {
      frozenList = null;
      frozenCloud = null;
    } else if (freezeTagCloud) {
      frozenCloud = loadCachedTagCloud(paginationKey);
    } else {
      frozenCloud = null;
    }
  }

  $: if (freezeFeed && !frozenList && !freezeTimer && bookmarks.length > 0) {
    freezeTimer = setTimeout(() => {
      frozenList = [...bookmarks];
      frozenCloud = tagCloudFrom(bookmarks);
      saveCachedTagCloud(paginationKey, frozenCloud);
    }, FREEZE_DELAY_MS);
  }

  onDestroy(() => {
    if (freezeTimer) clearTimeout(freezeTimer);
    if (tagCloudTimer) clearTimeout(tagCloudTimer);
    if (relayStartTimer) clearTimeout(relayStartTimer);
    if (relayPollTimer) clearInterval(relayPollTimer);
  });

  /** How many bookmarks have arrived since we froze that aren't in the
   *  current snapshot. Surfaced as the banner count. */
  $: pendingCount = frozenList
    ? bookmarks.filter((b) => !frozenList!.some((f) => f.eventId === b.eventId)).length
    : 0;

  let visibleLimit = pageSize;
  let lastPaginationSignature = '';
  let notePrimeSignature = '';
  $: renderSource = frozenList ?? bookmarks;
  $: resolvedVersion = $resolvedEventsVersion;
  $: renderableSource = renderSource.filter((bookmark) => isRenderableBookmark(bookmark, resolvedVersion));
  $: paginationSignature = `${paginationKey}:${pageSize}:${renderSource[0]?.eventId ?? ''}:${renderSource[1]?.eventId ?? ''}`;
  $: if (paginationSignature !== lastPaginationSignature) {
    visibleLimit = pageSize;
    lastPaginationSignature = paginationSignature;
  }
  $: displayedBookmarks = paginate ? renderableSource.slice(0, visibleLimit) : renderableSource;
  $: notePrimeSource = renderNostrNoteBookmarks
    ? renderSource.slice(0, Math.min(renderSource.length, Math.max(visibleLimit * 4, NOTE_PRIME_WINDOW)))
    : [];
  $: notePrimeTargets = renderNostrNoteBookmarks
    ? notePrimeSource.map(noteBookmarkTarget).filter(Boolean)
    : [];
  $: nextNotePrimeSignature = notePrimeTargets.join(',');
  $: if (nextNotePrimeSignature && nextNotePrimeSignature !== notePrimeSignature) {
    notePrimeSignature = nextNotePrimeSignature;
    void primeEvents(notePrimeTargets);
  }
  $: hasMore = paginate && visibleLimit < renderableSource.length;
  $: shownCount = Math.min(visibleLimit, renderableSource.length);
  $: summarySource = summaryBookmarks ?? bookmarks;
  $: nextTagCloudSourceSignature = tagCloudSignature(summarySource);
  $: if (!freezeFeed && freezeTagCloud && nextTagCloudSourceSignature !== tagCloudSourceSignature) {
    tagCloudSourceSignature = nextTagCloudSourceSignature;
    if (tagCloudTimer) clearTimeout(tagCloudTimer);
    if (summarySource.length > 0) {
      const snapshot = [...summarySource];
      tagCloudTimer = setTimeout(() => {
        frozenCloud = tagCloudFrom(snapshot);
        saveCachedTagCloud(paginationKey, frozenCloud);
        tagCloudTimer = null;
      }, FREEZE_DELAY_MS);
    }
  }
  $: tagCloud = frozenCloud ?? (freezeTagCloud && !freezeFeed ? null : tagCloudFrom(summarySource));
  $: stats = showStats ? userStatsFrom(summarySource) : null;

  // Live relay-status snapshot for the user's configured storage relays.
  // NDK's pool may also contain discovery/read sockets (NIP-65 lookups,
  // profile reads, etc.); those are intentionally filtered out here so
  // the sidebar does not imply they are account relays.
  let relayStatus: { url: string; ok: boolean; status: string }[] = [];
  let relayStartTimer: ReturnType<typeof setTimeout> | null = null;
  let relayPollTimer: ReturnType<typeof setInterval> | null = null;
  type RelayStatusEnum = typeof import('@nostr-dev-kit/ndk').NDKRelayStatus;
  type RelayModules = {
    ensureRelayUrlsConnected: (urls: readonly string[]) => void;
    getNdk: () => { pool: { relays: Map<string, { url: string; status: number }> } };
    NDKRelayStatus: RelayStatusEnum;
  };
  let relayModulesPromise: Promise<RelayModules> | null = null;
  function loadRelayModules(): Promise<RelayModules> {
    relayModulesPromise ??= Promise.all([
      import('$lib/nostr/ndk'),
      import('@nostr-dev-kit/ndk'),
    ]).then(([ndkModule, ndkPackage]) => ({
      ensureRelayUrlsConnected: ndkModule.ensureRelayUrlsConnected,
      getNdk: ndkModule.getNdk,
      NDKRelayStatus: ndkPackage.NDKRelayStatus,
    }));
    return relayModulesPromise;
  }
  function normalizeRelayUrl(url: string): string {
    return url.replace(/\/$/, '');
  }
  function statusLabel(status: number, NDKRelayStatus: RelayStatusEnum): string {
    switch (status) {
      case NDKRelayStatus.DISCONNECTING: return 'disconnecting';
      case NDKRelayStatus.DISCONNECTED: return 'disconnected';
      case NDKRelayStatus.RECONNECTING: return 'reconnecting';
      case NDKRelayStatus.FLAPPING: return 'unstable';
      case NDKRelayStatus.CONNECTING: return 'connecting';
      case NDKRelayStatus.CONNECTED: return 'connected';
      case NDKRelayStatus.AUTH_REQUESTED: return 'auth requested';
      case NDKRelayStatus.AUTHENTICATING: return 'authenticating';
      case NDKRelayStatus.AUTHENTICATED: return 'connected';
      default: return 'unknown';
    }
  }
  async function refreshRelayStatus(): Promise<void> {
    try {
      const { ensureRelayUrlsConnected, getNdk, NDKRelayStatus } = await loadRelayModules();
      const configuredUrls = $userSettings.relays
        .filter((r) => r.read || r.write)
        .map((r) => normalizeRelayUrl(r.url));
      ensureRelayUrlsConnected(configuredUrls);
      const pool = getNdk().pool;
      const poolByUrl = new Map(
        [...pool.relays.values()].map((r) => [normalizeRelayUrl(r.url), r]),
      );
      relayStatus = configuredUrls.map((url) => {
        const relay = poolByUrl.get(url);
        return {
          url,
          ok: !!relay && relay.status >= NDKRelayStatus.CONNECTED,
          status: relay ? statusLabel(relay.status, NDKRelayStatus) : 'disconnected',
        };
      });
    } catch {
      relayStatus = [];
    }
  }
  onMount(() => {
    relayStartTimer = setTimeout(() => {
      void refreshRelayStatus();
    }, 250);
    relayPollTimer = setInterval(() => {
      void refreshRelayStatus();
    }, 2000);
  });

  function showPending() {
    frozenList = [...bookmarks];
    frozenCloud = tagCloudFrom(bookmarks);
    saveCachedTagCloud(paginationKey, frozenCloud);
  }

  function loadMore() {
    visibleLimit = Math.min(visibleLimit + pageSize, renderableSource.length);
  }

  type NostrSourceBookmark = ParsedBookmark & {
    source?: string;
    sourceEventId?: string;
  };

  function noteBookmarkTarget(bookmark: ParsedBookmark): string {
    if (!renderNostrNoteBookmarks) return '';
    const source = bookmark as NostrSourceBookmark;
    if (
      bookmark.eventId.startsWith('nip51-note:') &&
      source.source === 'nostr-note-link' &&
      source.sourceEventId &&
      /^[0-9a-f]{64}$/i.test(source.sourceEventId)
    ) {
      return source.sourceEventId;
    }
    return extractNostrEventIdFromUrl(bookmark.url) ?? '';
  }

  function isRenderableBookmark(bookmark: ParsedBookmark, _resolvedVersion: number): boolean {
    const target = noteBookmarkTarget(bookmark);
    if (!target) return true;
    return peekResolvedEvent(target)?.kind === 1;
  }

  function tagCloudSignature(list: ParsedBookmark[]): string {
    if (list.length === 0) return `${paginationKey}:0`;
    return `${paginationKey}:${list.length}:${list[0]?.eventId ?? ''}:${list[list.length - 1]?.eventId ?? ''}`;
  }

  function tagCloudCacheKey(key: string): string {
    return TAG_CLOUD_CACHE_PREFIX + (key || 'default');
  }

  function loadCachedTagCloud(key: string): TagCloudItem[] | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(tagCloudCacheKey(key));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as TagCloudItem[];
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function saveCachedTagCloud(key: string, cloud: TagCloudItem[]): void {
    if (typeof localStorage === 'undefined' || cloud.length === 0) return;
    try {
      localStorage.setItem(tagCloudCacheKey(key), JSON.stringify(cloud));
    } catch {
      // Quota/private mode: live tags still render after the settle window.
    }
  }

  let sidebarTagScope: 'network' | 'mine' = 'mine';
  $: sidebarTagScope = tagScope === 'network' ? 'network' : 'mine';
</script>

<div class="bookmark-list-layout">
  <div class="main">
    <slot name="prepend" />

    {#if showPendingBanner && pendingCount > 0}
      <button type="button" class="pending-banner" on:click={showPending}>
        ↑ {pendingCount} new bookmark{pendingCount === 1 ? '' : 's'} — show
      </button>
    {/if}

    {#if displayedBookmarks.length === 0}
      <div class="empty">{loading ? 'no items' : emptyMessage}</div>
    {:else}
      {#each displayedBookmarks as b (b.eventId)}
        {@const noteTarget = noteBookmarkTarget(b)}
        {#if noteTarget}
          <NoteCard
            targetEventId={noteTarget}
            zapSats={bookmarkZapSats(b, zapSatsByEventId)}
            savedByPubkey={b.curator}
            savedAt={b.savedAt}
            clamp={false}
            showLinkPreviews={richPreviews}
          />
        {:else}
          <BookmarkCard
            bookmark={b}
            {tagScope}
            zapSats={bookmarkZapSats(b, zapSatsByEventId)}
            richPreview={richPreviews}
            {showCurator}
            showAuthorAvatar={showAuthorAvatars}
          />
        {/if}
      {/each}
      {#if hasMore}
        <div class="load-more-wrap">
          <button type="button" class="load-more" on:click={loadMore}>
            load more
          </button>
          <span>showing {shownCount.toLocaleString()} of {renderableSource.length.toLocaleString()}</span>
        </div>
      {/if}
    {/if}

    <slot name="append" />
  </div>

  <Sidebar {tagCloud} {stats} {showStats} {archivedCountOverride} {mediaCountOverride} relays={relayStatus} tagScope={sidebarTagScope} />
</div>

<style>
  .bookmark-list-layout {
    display: grid;
    grid-template-columns: minmax(0, 1160px) minmax(240px, 320px);
    justify-content: space-between;
    align-items: start;
    padding: 30px 24px 24px;
    column-gap: clamp(36px, 5vw, 96px);
  }
  .main {
    min-width: 0;
    width: 100%;
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
  .load-more-wrap {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 12px;
    margin: 18px 0 8px;
    color: var(--muted);
    font-size: 12px;
  }
  .load-more {
    border: 1px solid var(--rule);
    background: var(--surface);
    color: var(--link);
    border-radius: 999px;
    padding: 8px 14px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .load-more:hover {
    border-color: var(--coral);
    color: var(--coral-deep);
  }
  @media (max-width: 720px) {
    .bookmark-list-layout {
      display: flex;
      flex-direction: column;
      gap: 28px;
      padding: 20px;
    }
    .load-more-wrap {
      flex-direction: column;
      gap: 8px;
    }
  }
</style>
