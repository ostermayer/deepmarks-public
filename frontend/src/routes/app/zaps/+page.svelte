<script lang="ts">
  // /app/zaps — bookmarks the signed-in user has zapped.
  //
  // Source signal: kind:9734 zap-request events authored by the user.
  // Each carries an `e` tag pointing at the bookmark event that was
  // zapped. We query those, extract distinct e-tag values, then
  // subscribe to the matching kind:39701 events.
  //
  // Why kind:9734 instead of kind:9735 receipts? The receipt is signed
  // by the LNURL service, not the user, so finding "MY zaps" via
  // receipts requires parsing the receipt's `description` tag which
  // re-embeds the original 9734. The 9734 itself, when published to
  // relays (most clients including ours do), has the user as the
  // direct author — a much cleaner filter.
  //
  // Two-tier cache same as the other surfaces: NDK Dexie persists
  // both the 9734s and the resolved kind:39701s; localStorage primes
  // the rendered list synchronously so the page paints instantly.

  import { onDestroy, onMount } from 'svelte';
  import { writable, derived, type Readable } from 'svelte/store';
  import { browser } from '$app/environment';
  import { NDKSubscriptionCacheUsage, type NDKEvent, type NDKKind } from '@nostr-dev-kit/ndk';
  import Subheader from '$lib/components/Subheader.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import { getNdk } from '$lib/nostr/ndk';
  import { parseBookmarkEvent, type ParsedBookmark, type SignedEventLike } from '$lib/nostr/bookmarks';
  import { session } from '$lib/stores/session';

  const ZAP_REQUEST_KIND = 9734;
  const BOOKMARK_KIND = 39701;
  const LS_KEY = 'deepmarks-my-zaps:v1:';

  function lsLoad(pubkey: string): ParsedBookmark[] {
    if (!browser) return [];
    try {
      const raw = localStorage.getItem(LS_KEY + pubkey);
      return raw ? (JSON.parse(raw) as ParsedBookmark[]) : [];
    } catch { return []; }
  }
  function lsSave(pubkey: string, list: ParsedBookmark[]): void {
    if (!browser) return;
    try { localStorage.setItem(LS_KEY + pubkey, JSON.stringify(list)); }
    catch { /* quota */ }
  }

  // The set of bookmark event-ids the user has zapped — built from
  // kind:9734 e-tags. Used as the second-stage filter.
  const zappedEventIds = writable<Set<string>>(new Set());
  // Resolved kind:39701 events keyed by event id.
  const bookmarks = writable<Map<string, ParsedBookmark>>(new Map());

  let unsubReq: (() => void) | null = null;
  let unsubBookmarks: (() => void) | null = null;

  $: pubkey = $session.pubkey;
  $: if (pubkey) {
    // Sync prime on mount / pubkey change.
    const cached = lsLoad(pubkey);
    bookmarks.set(new Map(cached.map((b) => [b.eventId, b])));
  }
  $: if (pubkey) {
    teardown();
    startZapRequestSub(pubkey);
  }

  function teardown() {
    if (unsubReq) { unsubReq(); unsubReq = null; }
    if (unsubBookmarks) { unsubBookmarks(); unsubBookmarks = null; }
  }

  function startZapRequestSub(pk: string) {
    const ndk = getNdk();
    const sub = ndk.subscribe(
      { kinds: [ZAP_REQUEST_KIND], authors: [pk], limit: 200 },
      { closeOnEose: false, cacheUsage: NDKSubscriptionCacheUsage.PARALLEL },
    );
    sub.on('event', (event: NDKEvent) => {
      const eTagIds: string[] = event.tags
        .filter((t) => t[0] === 'e' && typeof t[1] === 'string')
        .map((t) => t[1] as string);
      let added = false;
      zappedEventIds.update((curr) => {
        const next = new Set<string>(curr);
        for (const id of eTagIds) {
          if (!next.has(id)) { next.add(id); added = true; }
        }
        return next;
      });
      if (added) restartBookmarkSub();
    });
    unsubReq = () => sub.stop();
  }

  function restartBookmarkSub() {
    if (unsubBookmarks) { unsubBookmarks(); unsubBookmarks = null; }
    let ids: string[] = [];
    zappedEventIds.subscribe((s) => { ids = [...s]; })();
    if (ids.length === 0) return;
    const ndk = getNdk();
    const sub = ndk.subscribe(
      { kinds: [BOOKMARK_KIND as unknown as NDKKind], ids },
      { closeOnEose: false, cacheUsage: NDKSubscriptionCacheUsage.PARALLEL },
    );
    sub.on('event', (event: NDKEvent) => {
      const parsed = parseBookmarkEvent(event as unknown as SignedEventLike);
      if (!parsed) return;
      bookmarks.update((m) => {
        const next = new Map(m);
        next.set(parsed.eventId, parsed);
        return next;
      });
      if (pubkey) {
        let snapshot: ParsedBookmark[] = [];
        bookmarks.subscribe((m) => { snapshot = [...m.values()]; })();
        lsSave(pubkey, snapshot);
      }
    });
    unsubBookmarks = () => sub.stop();
  }

  onMount(() => {
    if (pubkey) startZapRequestSub(pubkey);
  });
  onDestroy(teardown);

  $: visible = derived(bookmarks, ($m): ParsedBookmark[] =>
    [...$m.values()].sort((a, b) => b.savedAt - a.savedAt),
  ) as Readable<ParsedBookmark[]>;
</script>

<svelte:head><title>my zaps — Deepmarks</title></svelte:head>

<Subheader context="⚡ my zaps" />

{#if !pubkey}
  <p class="hint">sign in to see bookmarks you've zapped.</p>
{:else}
  <BookmarkList
    bookmarks={$visible}
    loading={true}
    showStats={false}
    freezeFeed={false}
    emptyMessage="you haven't zapped any bookmarks yet — tap ⚡ on any row to send sats to the curator."
  />
{/if}

<style>
  .hint {
    max-width: 1040px;
    margin: 0 auto;
    padding: 24px;
    color: var(--ink);
    font-size: 14px;
    line-height: 1.55;
  }
</style>
