<script lang="ts">
  import { derived, writable, type Readable } from 'svelte/store';
  import Subheader from '$lib/components/Subheader.svelte';
  import SaveBox from '$lib/components/SaveBox.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import NoteCard from '$lib/components/NoteCard.svelte';
  import LandingFeedRow from '$lib/components/LandingFeedRow.svelte';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import {
    createImportedBookmarksFeed,
    createImportedNoteRefsFeed,
    type ImportedNoteRef,
    type ImportedUrlBookmark,
  } from '$lib/nostr/imported-bookmarks';
  import { fetchOwnPrivateSet, parsePrivateEntry } from '$lib/nostr/private-bookmarks';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { session, canSign } from '$lib/stores/session';

  type Tab = 'bookmarks' | 'posts';
  const tab = writable<Tab>('bookmarks');

  /** A posts-tab entry — URL (render via LandingFeedRow) or note ref
   *  (render via NoteCard). Merged + sorted chronologically. */
  type PostEntry =
    | { kind: 'url'; data: ImportedUrlBookmark }
    | { kind: 'note'; data: ImportedNoteRef };

  // kind:39701 — the user's Deepmarks saves.
  $: feed = $session.pubkey
    ? createBookmarkFeed({ authors: [$session.pubkey], limit: 200 })
    : null;

  // kind:10003 / kind:30003 — bookmarks the user made via Damus / Primal
  // (URLs as r-tags, notes as e-tags). Surface under "posts" so Nostr-
  // native bookmarks are one click away from the main view.
  $: postUrls = $session.pubkey
    ? createImportedBookmarksFeed({ authors: [$session.pubkey], limit: 200 })
    : null;

  $: postNotes = $session.pubkey
    ? createImportedNoteRefsFeed({ authors: [$session.pubkey], limit: 200 })
    : null;

  // Private bookmarks (kind:30003 NIP-51 set, decrypted client-side via
  // the active signer). Three-tier cache for instant paint:
  //  1. localStorage of the LAST decrypted entry array, keyed by
  //     pubkey. Synchronous prime — store has data before the page
  //     even commits its first paint.
  //  2. NDK Dexie cache of the encrypted kind:30003 event (from the
  //     shared ndk.ts adapter). fetchOwnPrivateSet hits this in
  //     ~50ms on reload, faster than the relay round-trip.
  //  3. Live relay fetch — the canSign-gated decrypt below. Updates
  //     localStorage on success so the next refresh primes from the
  //     freshest decrypted state.
  const PRIVATE_LS_PREFIX = 'deepmarks-private-bookmarks:v3:';
  function lsLoadPrivate(pubkey: string): ParsedBookmark[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(PRIVATE_LS_PREFIX + pubkey);
      return raw ? (JSON.parse(raw) as ParsedBookmark[]) : [];
    } catch { return []; }
  }
  function lsSavePrivate(pubkey: string, list: ParsedBookmark[]): void {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(PRIVATE_LS_PREFIX + pubkey, JSON.stringify(list)); }
    catch { /* quota */ }
  }

  const privateBookmarks = writable<ParsedBookmark[]>([]);
  let lastFetchedPubkey: string | null = null;
  // Sync prime as soon as the pubkey is known.
  $: if ($session.pubkey && $session.pubkey !== lastFetchedPubkey) {
    privateBookmarks.set(lsLoadPrivate($session.pubkey));
  }
  // Live decrypt once canSign is true. Don't refire on every reactive
  // tick — only when the pubkey changes.
  $: if ($session.pubkey && $canSign && $session.pubkey !== lastFetchedPubkey) {
    lastFetchedPubkey = $session.pubkey;
    void loadPrivate($session.pubkey);
  }
  async function loadPrivate(pubkey: string) {
    try {
      const set = await fetchOwnPrivateSet(pubkey);
      const parsed: ParsedBookmark[] = [];
      const savedAt = Math.floor(Date.now() / 1000);
      for (const entry of set.entries) {
        const p = parsePrivateEntry(entry, pubkey, savedAt, '');
        if (p) parsed.push(p);
      }
      // Defensive: don't clobber a populated cache with [] on a
      // transient miss. parsed.length === 0 could mean either an
      // empty set (legit) or a relay timeout (transient); the cache
      // is the better signal until next refresh.
      if (parsed.length > 0) {
        privateBookmarks.set(parsed);
        lsSavePrivate(pubkey, parsed);
      }
    } catch {
      /* keep cache */
    }
  }

  // De-dup by URL — a bookmark can exist as both public (kind:39701) and
  // private (NIP-51 entry) if the user toggled visibility. Private wins
  // as the more current/intentional state, mirroring the extension's
  // Recent merge.
  $: bookmarks = ((feed ?? derived([], () => [] as ParsedBookmark[]))
    && derived([feed ?? derived([], () => [] as ParsedBookmark[]), privateBookmarks], ([$pub, $priv]) => {
      const byUrl = new Map<string, ParsedBookmark>();
      for (const b of $pub) byUrl.set(b.url, b);
      for (const b of $priv) byUrl.set(b.url, b);
      return [...byUrl.values()].sort((a, b) => b.savedAt - a.savedAt);
    })) as Readable<ParsedBookmark[]>;

  $: postsEntries = ((postUrls && postNotes)
    ? derived([postUrls, postNotes], ([$urls, $notes]) => {
        const merged: PostEntry[] = [
          ...$urls.map((u) => ({ kind: 'url' as const, data: u })),
          ...$notes.map((n) => ({ kind: 'note' as const, data: n })),
        ];
        merged.sort((a, b) => b.data.savedAt - a.data.savedAt);
        return merged;
      })
    : derived([], () => [] as PostEntry[])) as Readable<PostEntry[]>;

  // Sort + filter applied to the user's own bookmark list. The sort
  // row in Subheader writes here on click.
  type Sort = 'newest' | 'most-saved' | 'most-zapped' | 'archived-only';
  const sort = writable<Sort>('newest');

  // Save-count + zap-total live in the public Meili index (the seeder
  // populates them). For private bookmarks we have no popularity
  // signal; treat them as zero. The sort below leaves them in
  // newest-order at the bottom of "popular" / "most-zapped" rather
  // than scattered randomly.
  $: visibleBookmarks = derived([bookmarks, sort], ([$b, $s]): ParsedBookmark[] => {
    const list = $s === 'archived-only' ? $b.filter((x) => x.archivedForever) : [...$b];
    switch ($s) {
      case 'newest':
      case 'archived-only':
        list.sort((a, b) => b.savedAt - a.savedAt);
        break;
      case 'most-saved':
      case 'most-zapped':
        // No save_count / zap_total on ParsedBookmark today (those
        // are server-side aggregations). Until we plumb them through,
        // fall back to recency so the option is at least responsive.
        list.sort((a, b) => b.savedAt - a.savedAt);
        break;
    }
    return list;
  }) as Readable<ParsedBookmark[]>;
</script>

<svelte:head><title>your bookmarks — Deepmarks</title></svelte:head>

<div class="tab-row">
  <button
    type="button"
    class:active={$tab === 'bookmarks'}
    on:click={() => tab.set('bookmarks')}
  >
    bookmarks
    <span class="count">{$bookmarks.length}</span>
  </button>
  <button
    type="button"
    class:active={$tab === 'posts'}
    on:click={() => tab.set('posts')}
  >
    posts
    <span class="count">{$postsEntries.length}</span>
  </button>
</div>

{#if $tab === 'bookmarks'}
  <Subheader
    sorts={[
      { label: 'newest',          id: 'newest',     current: $sort === 'newest' },
      { label: 'most-saved',      id: 'most-saved', current: $sort === 'most-saved' },
      { label: '⚡ most-zapped',  id: 'most-zapped', current: $sort === 'most-zapped' },
      { label: 'archived only',   id: 'archived-only', current: $sort === 'archived-only' },
    ]}
    onSort={(id) => sort.set(id as Sort)}
  />
  <BookmarkList bookmarks={$visibleBookmarks} loading={!!feed} showStats={true} freezeFeed={false} emptyMessage={$sort === 'archived-only' ? 'no archived bookmarks yet — toggle "archive forever" on save' : 'no bookmarks yet — paste a URL to save your first'}>
    <SaveBox slot="prepend" />
  </BookmarkList>
{:else}
  <div class="posts-stream">
    {#if $postsEntries.length === 0}
      <p class="empty">no posts bookmarked from Damus / Primal yet — this tab shows your kind:10003 / 30003 saves from social Nostr clients.</p>
    {:else}
      {#each $postsEntries as entry (entry.kind === 'url' ? `u:${entry.data.eventId}:${entry.data.url}` : `n:${entry.data.listEventId}:${entry.data.targetEventId}`)}
        {#if entry.kind === 'url'}
          <LandingFeedRow bookmark={entry.data} />
        {:else}
          <NoteCard targetEventId={entry.data.targetEventId} />
        {/if}
      {/each}
    {/if}
  </div>
{/if}

<style>
  .posts-stream {
    max-width: 820px;
    margin: 0 auto;
    padding: 18px 24px 60px;
  }
  .empty {
    color: var(--muted);
    font-size: 13px;
    padding: 16px 0;
  }
  .tab-row {
    display: flex;
    gap: 24px;
    padding: 12px 24px 12px 62px;
    border-bottom: 1px solid var(--rule);
    background: var(--paper);
  }
  .tab-row button {
    background: transparent;
    border: 0;
    padding: 4px 0;
    font-family: inherit;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    position: relative;
  }
  .tab-row button:hover {
    color: var(--ink);
  }
  .tab-row button.active {
    color: var(--ink-deep);
    font-weight: 600;
  }
  .tab-row button.active::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: -13px;
    height: 2px;
    background: var(--coral);
  }
  .tab-row .count {
    font-family: 'Courier New', monospace;
    font-size: 10px;
    color: var(--muted);
    background: var(--paper-warm);
    border-radius: 100px;
    padding: 1px 7px;
    letter-spacing: 0;
    font-weight: normal;
  }
</style>
