<script lang="ts">
  import { page } from '$app/stores';
  import { onDestroy } from 'svelte';
  import { nip19 } from 'nostr-tools';
  import { derived, writable, type Readable } from 'svelte/store';
  import Avatar from '$lib/components/Avatar.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import LifetimeBadge from '$lib/components/LifetimeBadge.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import { api, ApiError } from '$lib/api/client';
  import { bookmarksForCollection, collectionSlugFromInput, collectionTitleFromSlug, type BookmarkCollection } from '$lib/bookmark-collections';
  import { createPublicCollectionsFeed } from '$lib/nostr/collections';
  import { cachedBookmarkFeedSnapshot } from '$lib/nostr/feed-cache';
  import { compareBookmarksNewest, type ParsedBookmark } from '$lib/nostr/bookmarks';
  import { getProfile } from '$lib/nostr/profiles';
  import { getUsername } from '$lib/nostr/username';
  import { mergePublicBookmarkLists, publicBookmarkToParsed } from '$lib/public-bookmarks';

  $: id = $page.params.slug;
  $: collectionParam = $page.params.collection ?? '';
  $: collectionSlug = collectionSlugFromInput(collectionParam);

  $: directPubkey = (() => {
    if (!id) return null;
    try {
      const decoded = nip19.decode(id);
      if (decoded.type === 'npub') return decoded.data as string;
    } catch { /* handle hex or short name below */ }
    return /^[0-9a-f]{64}$/i.test(id) ? id.toLowerCase() : null;
  })();

  let handlePubkey: string | null | undefined = null;
  let handleLookupFor = '';
  let lookupError = '';

  $: if (id && !directPubkey && id !== handleLookupFor) {
    const lookingUp = id;
    handleLookupFor = lookingUp;
    handlePubkey = null;
    lookupError = '';
    api.username
      .lookup(lookingUp)
      .then((res) => {
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
  $: resolving = !directPubkey && handleLookupFor === id && handlePubkey === null;
  $: npub = pubkey ? (() => {
    try { return nip19.npubEncode(pubkey); } catch { return id; }
  })() : id;
  $: feedSlug = id ?? npub ?? pubkey ?? '';
  $: profile = pubkey ? getProfile(pubkey) : null;
  $: handleStore = pubkey ? getUsername(pubkey) : null;

  const apiBookmarks = writable<ParsedBookmark[]>([]);
  const relayBookmarks = writable<ParsedBookmark[]>([]);
  const publicCollections = writable<BookmarkCollection[]>([]);
  const publicBookmarks: Readable<ParsedBookmark[]> = derived(
    [apiBookmarks, relayBookmarks],
    ([$apiBookmarks, $relayBookmarks]) =>
      mergePublicBookmarkLists($apiBookmarks, $relayBookmarks).sort(compareBookmarksNewest),
  );

  let feedPubkey: string | null = null;
  let feedToken = 0;
  let relayStop: (() => void) | null = null;
  let collectionsStop: (() => void) | null = null;
  let relayTimer: ReturnType<typeof setTimeout> | null = null;
  let loading = false;
  let collectionKey = '';
  let nextCollectionKey = '';

  $: if (pubkey && pubkey !== feedPubkey) startFeed(pubkey);
  $: if (!pubkey && feedPubkey !== null) clearFeed();
  $: nextCollectionKey = `${pubkey ?? ''}:${collectionSlug}`;
  $: if (nextCollectionKey !== collectionKey) {
    collectionKey = nextCollectionKey;
  }

  function clearFeed(): void {
    feedPubkey = null;
    feedToken += 1;
    if (relayTimer) clearTimeout(relayTimer);
    relayTimer = null;
    relayStop?.();
    collectionsStop?.();
    relayStop = null;
    collectionsStop = null;
    apiBookmarks.set([]);
    relayBookmarks.set([]);
    publicCollections.set([]);
    loading = false;
  }

  function startFeed(pk: string): void {
    clearFeed();
    feedPubkey = pk;
    const token = feedToken;
    loading = true;
    relayBookmarks.set(cachedBookmarkFeedSnapshot({ authors: [pk], limit: 500 }));

    void api.publicBookmarks(pk, 500)
      .then((res) => {
        if (feedPubkey !== pk || feedToken !== token) return;
        apiBookmarks.set(res.bookmarks.map(publicBookmarkToParsed));
      })
      .catch(() => {
        // Relay/cache data can still render a public collection.
      })
      .finally(() => {
        if (feedPubkey === pk && feedToken === token) loading = false;
      });

    relayTimer = setTimeout(() => {
      relayTimer = null;
      void import('$lib/nostr/feed')
        .then(({ createBookmarkFeed }) => {
          if (feedPubkey !== pk || feedToken !== token) return;
          relayStop = createBookmarkFeed({ authors: [pk], limit: 500 }).subscribe((list) => {
            relayBookmarks.set(list);
          });
        })
        .catch(() => {
          // API/cache still render.
        });
    }, 0);
    collectionsStop = createPublicCollectionsFeed({ authors: [pk], limit: 200 }).subscribe(publicCollections.set);
  }

  onDestroy(clearFeed);

  $: collection = $publicCollections.find((item) => item.slug === collectionSlug) ?? null;
  $: collectionTitle = collection?.title ?? collectionTitleFromSlug(collectionSlug);
  $: collectionBookmarks = bookmarksForCollection($publicBookmarks, collection, 'public').sort(compareBookmarksNewest);
  $: ownerName = $handleStore ?? $profile?.displayName ?? 'profile';
  $: pageTitle = `${collectionTitle} by ${ownerName} — Deepmarks`;
</script>

<svelte:head>
  <title>{pageTitle}</title>
  <meta
    name="description"
    content={`${collectionBookmarks.length.toLocaleString()} public bookmark${collectionBookmarks.length === 1 ? '' : 's'} in ${collectionTitle} by ${ownerName} on Deepmarks.`}
  />
</svelte:head>

<main class="collection-shell">
  <div class="collection-main">
    <a href="/app/bookmarks" class="back"><Logo size={20} flip /> Deepmarks</a>

    {#if pubkey}
      <header class="collection-head">
        <a class="owner" href={`/u/${encodeURIComponent(feedSlug)}`}>
          <span class="avatar-wrap">
            <Avatar {pubkey} size={44} label={$profile?.displayName} />
            <span class="lifetime-overlay"><LifetimeBadge {pubkey} size={15} /></span>
          </span>
          <span>
            <span class="owner-name">{ownerName}</span>
            <span class="owner-link">deepmarks.org/u/{feedSlug}</span>
          </span>
        </a>
        <div class="collection-title-row">
          <h1>{collectionTitle}</h1>
          <span class="count">{collectionBookmarks.length.toLocaleString()} public</span>
        </div>
        <p class="share-path">deepmarks.org/u/{feedSlug}/{collectionSlug}</p>
      </header>

      {#if !collectionSlug}
        <p class="empty">unknown collection.</p>
      {:else}
        <BookmarkList
          bookmarks={collectionBookmarks}
          loading={loading}
          emptyMessage="no public bookmarks in this collection yet."
          tagScope="network"
          showCurator={false}
          showAuthorAvatars={false}
          freezeFeed={false}
          paginationKey={`public-collection:${pubkey}:${collectionSlug}`}
        />
      {/if}
    {:else if resolving}
      <p class="unknown">looking up {id}...</p>
    {:else if lookupError}
      <p class="unknown">couldn't reach the server.</p>
    {:else}
      <p class="unknown">unknown user</p>
    {/if}
  </div>
</main>

<Footer />

<style>
  .collection-shell {
    display: block;
    padding: 16px 0 48px;
  }
  .collection-main {
    min-width: 0;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 0 24px 10px;
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
  .collection-head {
    padding: 14px;
    margin: 0 24px;
    border: 1px solid var(--rule);
    border-left: 4px solid var(--coral);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: 0 1px 0 rgba(5, 43, 68, 0.03);
  }
  .owner {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    max-width: 100%;
    color: var(--ink);
    text-decoration: none;
  }
  .owner:hover {
    color: var(--coral);
    text-decoration: none;
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
  .owner-name,
  .owner-link,
  .share-path {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .owner-name {
    color: var(--ink-deep);
    font-size: 13px;
    font-weight: 600;
  }
  .owner-link,
  .share-path {
    color: var(--muted);
    font-family: 'Courier New', monospace;
    font-size: 11px;
  }
  .collection-title-row {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 12px;
  }
  h1 {
    margin: 0;
    color: var(--ink-deep);
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 28px;
    font-weight: 600;
    letter-spacing: 0;
    line-height: 1.12;
  }
  .count {
    border-radius: 999px;
    background: var(--paper-warm);
    color: var(--muted);
    padding: 2px 8px;
    font-family: 'Courier New', monospace;
    font-size: 11px;
  }
  .share-path {
    margin-top: 8px;
  }
  .empty,
  .unknown {
    color: var(--muted);
    font-size: 13px;
    padding: 20px 0;
  }
  @media (max-width: 720px) {
    .collection-shell {
      padding: 14px 0 48px;
    }
    h1 {
      font-size: 24px;
    }
  }
</style>
