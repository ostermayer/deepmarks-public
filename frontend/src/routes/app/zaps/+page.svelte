<script lang="ts">
  // /app/zaps — bookmarks the signed-in user has zapped.
  //
  // Source signal: paid kind:9735 zap receipts. The receipt's
  // `description` tag embeds the signed kind:9734 zap request, whose
  // pubkey is the user who paid and whose e-tags identify the bookmark.
  // We parse those receipts, extract distinct e-tag values, then
  // subscribe to the matching kind:39701 events. We also keep a small
  // legacy 9734 subscription for clients that publish zap requests
  // directly, but Deepmarks itself does not rely on standalone 9734s.
  //
  // Two-tier cache same as the other surfaces: NDK Dexie persists
  // the receipts and resolved kind:39701s; localStorage primes the
  // rendered list synchronously so the page paints instantly.

  import { onDestroy } from 'svelte';
  import { writable, derived, type Readable } from 'svelte/store';
  import { browser } from '$app/environment';
  import { NDKSubscriptionCacheUsage, type NDKEvent, type NDKKind } from '@nostr-dev-kit/ndk';
  import Subheader from '$lib/components/Subheader.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import { getNdk } from '$lib/nostr/ndk';
  import { parseBookmarkEvent, type ParsedBookmark, type SignedEventLike } from '$lib/nostr/bookmarks';
  import { KIND } from '$lib/nostr/kinds';
  import { zappedBookmarkEventIdsFromReceipt } from '$lib/nostr/zap';
  import { session } from '$lib/stores/session';

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

  // The set of bookmark event-ids the user has zapped. Used as the
  // second-stage filter.
  const zappedEventIds = writable<Set<string>>(new Set());
  // Resolved kind:39701 events keyed by event id.
  const bookmarks = writable<Map<string, ParsedBookmark>>(new Map());
  let loading = false;

  let unsubReq: (() => void) | null = null;
  let unsubReceipts: (() => void) | null = null;
  let unsubBookmarks: (() => void) | null = null;
  let activePubkey: string | null = null;

  $: pubkey = $session.pubkey;
  $: if (pubkey !== activePubkey) {
    activePubkey = pubkey ?? null;
    teardown();
    zappedEventIds.set(new Set());
    bookmarks.set(new Map());
    loading = false;
    if (pubkey) {
      const cached = lsLoad(pubkey);
      bookmarks.set(new Map(cached.map((b) => [b.eventId, b])));
      loading = cached.length === 0;
      startZapReceiptSub(pubkey);
      startZapRequestSub(pubkey);
    }
  }

  function teardown() {
    if (unsubReq) { unsubReq(); unsubReq = null; }
    if (unsubReceipts) { unsubReceipts(); unsubReceipts = null; }
    if (unsubBookmarks) { unsubBookmarks(); unsubBookmarks = null; }
  }

  function addZappedEventIds(ids: string[]) {
    if (ids.length === 0) return;
    let added = false;
    zappedEventIds.update((curr) => {
      const next = new Set<string>(curr);
      for (const id of ids) {
        if (!next.has(id)) { next.add(id); added = true; }
      }
      return next;
    });
    if (added) restartBookmarkSub();
  }

  function markLoadedSoon() {
    setTimeout(() => { loading = false; }, 1200);
  }

  function startZapReceiptSub(pk: string) {
    const ndk = getNdk();
    const sub = ndk.subscribe(
      { kinds: [KIND.zapReceipt as unknown as NDKKind], limit: 1000 },
      { closeOnEose: false, cacheUsage: NDKSubscriptionCacheUsage.PARALLEL },
    );
    sub.on('event', (event: NDKEvent) => {
      addZappedEventIds(zappedBookmarkEventIdsFromReceipt(event.tags, pk));
    });
    sub.on('eose', () => { loading = false; });
    markLoadedSoon();
    unsubReceipts = () => sub.stop();
  }

  function startZapRequestSub(pk: string) {
    const ndk = getNdk();
    const sub = ndk.subscribe(
      { kinds: [KIND.zapRequest as unknown as NDKKind], authors: [pk], limit: 200 },
      { closeOnEose: false, cacheUsage: NDKSubscriptionCacheUsage.PARALLEL },
    );
    sub.on('event', (event: NDKEvent) => {
      addZappedEventIds(event.tags
        .filter((t) => t[0] === 'e' && typeof t[1] === 'string')
        .map((t) => t[1] as string));
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
      { kinds: [KIND.webBookmark as unknown as NDKKind], ids },
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
    {loading}
    showStats={false}
    freezeFeed={false}
    emptyMessage="you haven't zapped any bookmarks yet — tap ⚡ on any row to send sats."
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
