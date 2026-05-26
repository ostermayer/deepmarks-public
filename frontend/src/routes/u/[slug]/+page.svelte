<script lang="ts">
  // Public profile view — avatar, display name, bio, LN address, NIP-05,
  // npub, and two tabs of saves:
  //
  //   bookmarks  — kind:39701 events published through Deepmarks (or any
  //                client that speaks NIP-B0). The native URL bookmark.
  //   posts      — kind:1 note bookmarks referenced by kind:10003 /
  //                kind:30003 bookmark lists or by saved Nostr-note URLs.
  //
  // These kind:10003/30003 entries deliberately do NOT enter the site's
  // public popular / recent / network feeds — they stay profile-scoped so
  // the global firehose isn't flooded with personal reading lists.
  //
  // Routed by /u/[slug]; the param is one of:
  //   • a bech32 npub1…
  //   • a 64-char hex pubkey (legacy fallback)
  //   • a short deepmarks handle (lifetime-tier perk) — resolved at runtime
  //     via GET /account/username-lookup → pubkey.
  // Invalid / unknown slugs render a small "unknown user" placeholder
  // rather than throwing.

  import { page } from '$app/stores';
  import { onDestroy } from 'svelte';
  import { nip19 } from 'nostr-tools';
  import { derived, writable, type Readable } from 'svelte/store';
  import Avatar from '$lib/components/Avatar.svelte';
  import BookmarkCard from '$lib/components/BookmarkCard.svelte';
  import FeedIconLink from '$lib/components/FeedIconLink.svelte';
  import LifetimeBadge from '$lib/components/LifetimeBadge.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import { getProfile, profileLightningAddress } from '$lib/nostr/profiles';
  import { getUsername } from '$lib/nostr/username';
  import { api, ApiError } from '$lib/api/client';
  import { cachedBookmarkFeedSnapshot } from '$lib/nostr/feed-cache';
  import type { ImportedNoteRef, ImportedUrlBookmark } from '$lib/nostr/imported-bookmarks';
  import { session } from '$lib/stores/session';
  import { ownBookmarks } from '$lib/stores/own-bookmarks';
  import { contactList, follow, unfollow } from '$lib/nostr/contacts';
  import {
    compareBookmarksNewest,
    compareBookmarksOldest,
    type ParsedBookmark
  } from '$lib/nostr/bookmarks';
  import { extractNostrEventIdFromUrl } from '$lib/nostr/social-refs';

  type SavedNoteRef = ImportedNoteRef | {
    targetEventId: string;
    curator: string;
    savedAt: number;
    listEventId: string;
    listKind: number;
    listIdentifier: string;
    source: 'nip51-list-url';
  };

  /** A posts-tab entry is a bookmarked kind:1 note reference. URLs from
   *  NIP-51 r-tags only enter this stream when they contain a note/nevent
   *  id; generic web URLs stay in the bookmarks tab. */
  type PostEntry = { kind: 'note'; data: SavedNoteRef };

  type Tab = 'bookmarks' | 'posts';
  type BookmarkSort = 'newest' | 'oldest' | 'title-az' | 'title-za';
  type PostSort = 'newest' | 'oldest';
  const PAGE_SIZE = 50;
  const tab = writable<Tab>('bookmarks');
  let bookmarkSort: BookmarkSort = 'newest';
  let postSort: PostSort = 'newest';
  let bookmarkLimit = PAGE_SIZE;
  let postLimit = PAGE_SIZE;
  let paginationPubkey = '';
  let invalidPostIds = new Set<string>();
  let NoteCardComponent: typeof import('$lib/components/NoteCard.svelte').default | null = null;
  let followWorking = false;
  let followNotice = '';

  $: id = $page.params.slug;

  /** Synchronous pubkey resolution — handles npub + hex. Short handles are
   *  resolved async below and tracked separately so we only render the
   *  "unknown user" state once both paths have given up. */
  $: directPubkey = (() => {
    if (!id) return null;
    try {
      const d = nip19.decode(id);
      if (d.type === 'npub') return d.data as string;
    } catch { /* fall through to hex check */ }
    return /^[0-9a-f]{64}$/i.test(id) ? id.toLowerCase() : null;
  })();

  /** Handle-resolved pubkey. null = not-yet-tried, undefined = definitively not found. */
  let handlePubkey: string | null | undefined = null;
  /** Last slug we kicked a lookup for. Comparing to this inside the
   *  `.then` callback lets us discard stale responses when the user
   *  navigates handles faster than the API responds. */
  let handleLookupFor = '';
  /** Non-404 lookup failure (network / 5xx). Rendered as a retry prompt
   *  rather than "unknown user", which would falsely imply the user
   *  doesn't exist. */
  let lookupError = '';

  $: if (id && !directPubkey && id !== handleLookupFor) {
    const lookingUp = id;
    handleLookupFor = lookingUp;
    handlePubkey = null;
    lookupError = '';
    api.username
      .lookup(lookingUp)
      .then((res) => {
        // Ignore stale responses from a previous slug.
        if (handleLookupFor !== lookingUp) return;
        handlePubkey = res.pubkey;
      })
      .catch((e) => {
        if (handleLookupFor !== lookingUp) return;
        if (e instanceof ApiError && e.status === 404) {
          handlePubkey = undefined;
        } else {
          lookupError = (e as Error).message || 'lookup failed';
          handlePubkey = undefined;
        }
      });
  }

  $: pubkey = directPubkey ?? (typeof handlePubkey === 'string' ? handlePubkey : null);
  $: if ((pubkey ?? '') !== paginationPubkey) {
    paginationPubkey = pubkey ?? '';
    bookmarkSort = 'newest';
    postSort = 'newest';
    bookmarkLimit = PAGE_SIZE;
    postLimit = PAGE_SIZE;
    invalidPostIds = new Set();
  }
  /** True once every resolution path has returned. Prevents flashing
   *  "unknown user" while a handle lookup is still in flight. */
  $: resolving = !directPubkey && handleLookupFor === id && handlePubkey === null;

  $: npub = pubkey ? (() => {
    try { return nip19.npubEncode(pubkey); } catch { return id; }
  })() : id;
  $: feedSlug = id ?? npub ?? pubkey ?? '';
  $: userFeedUrl = pubkey && feedSlug ? `/feed/user/${encodeURIComponent(feedSlug)}.xml` : '';

  $: profile = pubkey ? getProfile(pubkey) : null;
  $: lightningAddress = profileLightningAddress($profile);
  $: handleStore = pubkey ? getUsername(pubkey) : null;

  const publicBookmarks = writable<ParsedBookmark[]>([]);
  let publicFeedPubkey: string | null = null;
  let publicFeedToken = 0;
  let publicFeedStop: (() => void) | null = null;
  let publicFeedTimer: ReturnType<typeof setTimeout> | null = null;

  $: if (pubkey && pubkey !== publicFeedPubkey) startPublicFeed(pubkey);
  $: if (!pubkey && publicFeedPubkey !== null) clearPublicFeed();

  function clearPublicFeed(): void {
    publicFeedPubkey = null;
    publicFeedToken += 1;
    if (publicFeedTimer) clearTimeout(publicFeedTimer);
    publicFeedTimer = null;
    publicFeedStop?.();
    publicFeedStop = null;
    publicBookmarks.set([]);
  }

  function startPublicFeed(pk: string): void {
    clearPublicFeed();
    publicFeedPubkey = pk;
    const token = publicFeedToken;
    publicBookmarks.set(cachedBookmarkFeedSnapshot({ authors: [pk], limit: 100 }));
    publicFeedTimer = setTimeout(() => {
      publicFeedTimer = null;
      void import('$lib/nostr/feed')
        .then(({ createBookmarkFeed }) => {
          if (publicFeedPubkey !== pk || publicFeedToken !== token) return;
          publicFeedStop = createBookmarkFeed({ authors: [pk], limit: 100 }).subscribe((list) => {
            publicBookmarks.set(list);
          });
        })
        .catch(() => {
          // Cached profile shell still renders.
        });
    }, 0);
  }

  const postUrls = writable<ImportedUrlBookmark[]>([]);
  const postNotes = writable<ImportedNoteRef[]>([]);
  let postFeedPubkey: string | null = null;
  let postFeedToken = 0;
  let postUrlStop: (() => void) | null = null;
  let postNoteStop: (() => void) | null = null;

  $: if ($tab === 'posts' && pubkey && pubkey !== postFeedPubkey) startPostFeeds(pubkey);
  $: if (!pubkey && postFeedPubkey !== null) clearPostFeeds();

  function clearPostFeeds(): void {
    postFeedPubkey = null;
    postFeedToken += 1;
    postUrlStop?.();
    postNoteStop?.();
    postUrlStop = null;
    postNoteStop = null;
    postUrls.set([]);
    postNotes.set([]);
    invalidPostIds = new Set();
  }

  async function startPostFeeds(pk: string): Promise<void> {
    clearPostFeeds();
    postFeedPubkey = pk;
    const token = postFeedToken;
    try {
      const [imported, noteCard] = await Promise.all([
        import('$lib/nostr/imported-bookmarks'),
        import('$lib/components/NoteCard.svelte'),
      ]);
      if (postFeedPubkey !== pk || postFeedToken !== token) return;
      NoteCardComponent = noteCard.default;
      postUrlStop = imported.createImportedBookmarksFeed({ authors: [pk], limit: 100 }).subscribe(postUrls.set);
      postNoteStop = imported.createImportedNoteRefsFeed({ authors: [pk], limit: 100 }).subscribe(postNotes.set);
    } catch {
      // Posts tab can retry on a refresh.
    }
  }

  $: isOwner = !!pubkey && $session.pubkey === pubkey;
  $: isFollowing = !!pubkey && $contactList.contacts.has(pubkey);

  $: bookmarks = (pubkey
    ? derived([publicBookmarks, ownBookmarks], ([$public, $own]) => (
        isOwner ? $own : $public
      ))
    : derived([], () => [] as ParsedBookmark[])) as Readable<ParsedBookmark[]>;

  function importedUrlToNoteEntry(bookmark: ImportedUrlBookmark): PostEntry | null {
    const targetEventId = extractNostrEventIdFromUrl(bookmark.url);
    if (!targetEventId) return null;
    return {
      kind: 'note',
      data: {
        targetEventId,
        curator: bookmark.curator,
        savedAt: bookmark.savedAt,
        listEventId: bookmark.eventId,
        listKind: bookmark.listKind,
        listIdentifier: bookmark.listIdentifier,
        source: 'nip51-list-url',
      },
    };
  }

  // Merge note refs with NIP-51 r-tags that point at note/nevent URLs.
  // Generic web URLs stay in the bookmarks tab; posts is only for kind:1.
  $: postsEntries = (pubkey
    ? derived([postUrls, postNotes], ([$urls, $notes]) => {
        const merged: PostEntry[] = [];
        for (const url of $urls) {
          const entry = importedUrlToNoteEntry(url);
          if (entry) merged.push(entry);
        }
        for (const note of $notes) merged.push({ kind: 'note', data: note });
        merged.sort((a, b) => b.data.savedAt - a.data.savedAt);
        return merged;
      })
    : derived([], () => [] as PostEntry[])) as Readable<PostEntry[]>;

  $: pageTitle = `${$handleStore ?? $profile?.displayName ?? 'profile'} — Deepmarks`;

  function bookmarkTitle(bookmark: ParsedBookmark | ImportedUrlBookmark): string {
    return (bookmark.title || bookmark.url).toLocaleLowerCase();
  }

  function sortBookmarks(list: ParsedBookmark[], sort: BookmarkSort): ParsedBookmark[] {
    const next = [...list];
    switch (sort) {
      case 'newest':
        next.sort(compareBookmarksNewest);
        break;
      case 'oldest':
        next.sort(compareBookmarksOldest);
        break;
      case 'title-az':
        next.sort((a, b) => bookmarkTitle(a).localeCompare(bookmarkTitle(b)));
        break;
      case 'title-za':
        next.sort((a, b) => bookmarkTitle(b).localeCompare(bookmarkTitle(a)));
        break;
    }
    return next;
  }

  function postTime(entry: PostEntry): number {
    return entry.data.savedAt;
  }

  function sortPosts(list: PostEntry[], sort: PostSort): PostEntry[] {
    const next = [...list];
    next.sort((a, b) => sort === 'oldest'
      ? postTime(a) - postTime(b)
      : postTime(b) - postTime(a));
    return next;
  }

  function handleInvalidPost(event: CustomEvent<{ targetEventId: string }>): void {
    const targetEventId = event.detail.targetEventId;
    if (invalidPostIds.has(targetEventId)) return;
    invalidPostIds = new Set(invalidPostIds).add(targetEventId);
  }

  function setBookmarkSort(sort: BookmarkSort): void {
    bookmarkSort = sort;
    bookmarkLimit = PAGE_SIZE;
  }

  function setPostSort(sort: PostSort): void {
    postSort = sort;
    postLimit = PAGE_SIZE;
  }

  function setTab(next: Tab): void {
    tab.set(next);
  }

  async function toggleFollow(): Promise<void> {
    if (!pubkey || !$session.pubkey || isOwner || followWorking) return;
    followWorking = true;
    followNotice = '';
    try {
      if (isFollowing) await unfollow(pubkey, $session.pubkey);
      else await follow(pubkey, $session.pubkey);
    } catch (e) {
      followNotice = (e as Error).message || 'follow failed';
    } finally {
      followWorking = false;
    }
  }

  onDestroy(() => {
    clearPublicFeed();
    clearPostFeeds();
  });

  $: sortedBookmarks = sortBookmarks($bookmarks, bookmarkSort);
  $: visibleBookmarks = sortedBookmarks.slice(0, bookmarkLimit);
  $: bookmarkHasMore = bookmarkLimit < sortedBookmarks.length;
  $: sortedPosts = sortPosts($postsEntries, postSort);
  $: displayPosts = sortedPosts.filter((entry) => !invalidPostIds.has(entry.data.targetEventId));
  $: visiblePosts = displayPosts.slice(0, postLimit);
  $: postsHaveMore = postLimit < displayPosts.length;
</script>

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>

<main class="profile-shell">
  <div class="profile-main">
    <a href="/app/bookmarks" class="back"><Logo size={20} flip /> Deepmarks</a>

    <header class="profile-head">
      {#if pubkey}
        <div class="avatar-wrap">
          <Avatar {pubkey} size={52} label={$profile?.displayName} />
          <span class="lifetime-overlay"><LifetimeBadge {pubkey} size={18} /></span>
        </div>
        <div class="meta">
          <div class="name-row">
            <h1>{$profile?.displayName ?? 'unnamed'}</h1>
            {#if $session.pubkey && !isOwner}
              <button type="button" class:active={isFollowing} on:click={toggleFollow} disabled={followWorking}>
                {followWorking ? 'saving...' : isFollowing ? 'following' : 'follow'}
              </button>
            {/if}
          </div>
          {#if followNotice}<p class="follow-notice">{followNotice}</p>{/if}
          {#if $handleStore}
            <p class="handle">deepmarks.org/u/{$handleStore}</p>
          {/if}
          {#if $profile?.nip05}
            <p class="nip05">{$profile.nip05}</p>
          {/if}
          {#if $profile?.about}
            <p class="about">{$profile.about}</p>
          {/if}
          <p class="npub"><code>{npub}</code></p>
          {#if lightningAddress}
            <p class="ln"><span class="zap-icon">⚡</span> {lightningAddress}</p>
          {/if}
        </div>
      {:else if resolving}
        <p class="unknown">looking up {id}…</p>
      {:else if lookupError}
        <p class="unknown">couldn't reach the server — <button type="button" class="retry" on:click={() => { handleLookupFor = ''; }}>retry</button></p>
      {:else}
        <p class="unknown">unknown user</p>
      {/if}
    </header>

    {#if pubkey}
      <section class="bookmarks">
        <div class="tab-row">
          <button
            type="button"
            class:active={$tab === 'bookmarks'}
            on:click={() => setTab('bookmarks')}
          >
            bookmarks
            <span class="count">{$bookmarks.length}</span>
          </button>
          <button
            type="button"
            class:active={$tab === 'posts'}
            on:click={() => setTab('posts')}
          >
            posts
            <span class="count">{displayPosts.length}</span>
          </button>
          <span class="feed-slot">
            <FeedIconLink href={userFeedUrl} label={`${$profile?.displayName ?? id} public bookmarks feed`} />
          </span>
        </div>

        {#if $tab === 'bookmarks'}
          <div class="sort-row">
            <span>sort:</span>
            <button type="button" class:active={bookmarkSort === 'newest'} on:click={() => setBookmarkSort('newest')}>newest</button>
            <button type="button" class:active={bookmarkSort === 'oldest'} on:click={() => setBookmarkSort('oldest')}>oldest</button>
            <button type="button" class:active={bookmarkSort === 'title-az'} on:click={() => setBookmarkSort('title-az')}>title a-z</button>
            <button type="button" class:active={bookmarkSort === 'title-za'} on:click={() => setBookmarkSort('title-za')}>title z-a</button>
          </div>
          {#if sortedBookmarks.length === 0}
            <p class="empty">{isOwner ? 'no bookmarks yet.' : 'no public bookmarks yet.'}</p>
          {:else}
            {#each visibleBookmarks as b (b.eventId)}
              <BookmarkCard bookmark={b} compact tagScope="network" showCurator={false} />
            {/each}
            {#if bookmarkHasMore}
              <div class="load-more-wrap">
                <button type="button" class="load-more" on:click={() => { bookmarkLimit = Math.min(bookmarkLimit + PAGE_SIZE, sortedBookmarks.length); }}>
                  load more
                </button>
                <span>showing {Math.min(bookmarkLimit, sortedBookmarks.length).toLocaleString()} of {sortedBookmarks.length.toLocaleString()}</span>
              </div>
            {/if}
          {/if}
        {:else}
          <div class="sort-row">
            <span>sort:</span>
            <button type="button" class:active={postSort === 'newest'} on:click={() => setPostSort('newest')}>newest</button>
            <button type="button" class:active={postSort === 'oldest'} on:click={() => setPostSort('oldest')}>oldest</button>
          </div>
          {#if displayPosts.length === 0}
            <p class="empty">no posts bookmarked from social Nostr clients yet.</p>
          {:else}
            {#each visiblePosts as entry (`n:${entry.data.listEventId}:${entry.data.targetEventId}`)}
              {#if NoteCardComponent}
                <svelte:component
                  this={NoteCardComponent}
                  targetEventId={entry.data.targetEventId}
                  on:invalid={handleInvalidPost}
                />
              {:else}
                <div class="simple-row is-placeholder">
                  <span class="simple-title">Nostr note</span>
                  <span class="simple-meta">loading note...</span>
                </div>
              {/if}
            {/each}
            {#if postsHaveMore}
              <div class="load-more-wrap">
                <button type="button" class="load-more" on:click={() => { postLimit = Math.min(postLimit + PAGE_SIZE, displayPosts.length); }}>
                  load more
                </button>
                <span>showing {Math.min(postLimit, displayPosts.length).toLocaleString()} of {displayPosts.length.toLocaleString()}</span>
              </div>
            {/if}
          {/if}
        {/if}
      </section>
    {/if}
  </div>
  <aside class="profile-rail" aria-hidden="true"></aside>
</main>

<Footer />

<style>
  .profile-shell {
    display: flex;
    gap: 36px;
    padding: 16px 24px 48px;
  }
  .profile-main {
    flex: 1;
    min-width: 0;
  }
  .profile-rail {
    width: 240px;
    flex: 0 0 240px;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    color: var(--ink-deep) !important;
    font-size: 15px;
    font-weight: 700;
    text-decoration: none;
    width: fit-content;
  }
  .back:hover {
    color: var(--coral) !important;
    text-decoration: none;
  }
  .profile-head {
    padding: 12px 14px;
    display: flex;
    gap: 12px;
    align-items: flex-start;
    border: 1px solid var(--rule);
    border-left: 4px solid var(--coral);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: 0 1px 0 rgba(5, 43, 68, 0.03);
  }
  .avatar-wrap {
    position: relative;
    flex-shrink: 0;
  }
  .lifetime-overlay {
    position: absolute;
    right: -3px;
    bottom: -3px;
    background: var(--paper);
    border-radius: 100%;
    padding: 2px;
    line-height: 0;
    box-shadow: 0 0 0 1px var(--rule);
  }
  .meta {
    flex: 1;
    min-width: 0;
  }
  h1 {
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 22px;
    font-weight: 600;
    color: var(--ink-deep);
    margin: 0;
    letter-spacing: -0.3px;
  }
  .name-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .name-row button {
    border: 1px solid var(--rule);
    background: var(--paper);
    color: var(--link);
    border-radius: 999px;
    padding: 5px 10px;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .name-row button:hover {
    border-color: var(--coral);
    color: var(--coral-deep);
  }
  .name-row button.active {
    border-color: var(--archive);
    background: var(--archive-soft);
    color: var(--ink-deep);
  }
  .name-row button:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .follow-notice {
    margin: 4px 0 0;
    color: var(--coral-deep);
    font-size: 12px;
  }
  .nip05 {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 12px;
  }
  .handle {
    margin: 2px 0 0;
    color: var(--coral-deep);
    font-size: 12px;
    font-weight: 500;
    font-family: 'Courier New', monospace;
  }
  .about {
    margin: 6px 0 0;
    color: var(--ink);
    line-height: 1.35;
    font-size: 13px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .npub {
    margin: 6px 0 0;
    font-size: 11px;
    color: var(--muted);
    max-width: min(100%, 560px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .npub code {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: bottom;
    font-family: 'Courier New', monospace;
    background: var(--paper-warm);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .ln {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--zap);
  }
  .zap-icon {
    margin-right: 4px;
  }
  .unknown {
    color: var(--muted);
    font-size: 13px;
    padding: 20px 0;
  }
  .retry {
    background: transparent;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--coral);
    cursor: pointer;
    text-decoration: underline;
  }
  .bookmarks {
    margin: 14px 0 0;
    padding: 12px 0 0;
    border-top: 1px solid var(--rule);
  }
  .tab-row {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 8px;
    padding-bottom: 6px;
    border-bottom: 2px solid var(--ink-deep);
    background: var(--paper);
    box-shadow: 0 1px 0 var(--rule);
  }
  .tab-row button {
    background: transparent;
    border: 0;
    padding: 4px 0;
    font-family: inherit;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .tab-row button:hover {
    color: var(--ink);
  }
  .tab-row button.active {
    color: var(--ink-deep);
    font-weight: 600;
  }
  .tab-row .count {
    font-family: 'Courier New', monospace;
    font-size: 10px;
    color: var(--muted);
    background: var(--paper-warm);
    border-radius: 100px;
    padding: 1px 7px;
    letter-spacing: 0;
  }
  .feed-slot {
    margin-left: auto;
    display: inline-flex;
  }
  .empty {
    color: var(--muted);
    font-size: 13px;
    padding: 16px 0;
  }
  .simple-row {
    display: block;
    padding: 10px 0;
    border-bottom: 1px dashed var(--rule);
    color: var(--ink-deep);
    text-decoration: none;
  }
  .simple-row:hover {
    color: var(--coral);
    text-decoration: none;
  }
  .simple-row.is-placeholder {
    color: var(--muted);
  }
  .simple-title {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.35;
  }
  .simple-meta {
    display: block;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-family: 'Courier New', monospace;
    font-size: 11px;
  }
  .sort-row {
    position: sticky;
    top: 37px;
    z-index: 19;
    display: flex;
    flex-wrap: wrap;
    gap: 9px;
    align-items: baseline;
    margin: 0 0 4px;
    padding: 4px 0 6px;
    background: var(--paper);
    color: var(--muted);
    font-size: 12px;
  }
  .sort-row button {
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--link);
    cursor: pointer;
    font: inherit;
  }
  .sort-row button:hover {
    color: var(--coral);
    text-decoration: underline;
  }
  .sort-row button.active {
    color: var(--ink-deep);
    font-weight: 600;
    text-decoration: none;
  }
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
    .profile-shell {
      padding: 14px 20px 48px;
    }
    .profile-rail {
      display: none;
    }
    .profile-head {
      padding: 12px;
      gap: 12px;
    }
    .back {
      margin-bottom: 14px;
    }
    .load-more-wrap {
      flex-direction: column;
      gap: 8px;
    }
  }
  @media (max-width: 1040px) {
    .profile-rail {
      display: none;
    }
  }
</style>
