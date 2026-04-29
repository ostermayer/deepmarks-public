<script lang="ts">
  // /app/follows — bookmarks from people the signed-in user follows.
  //
  // Subscribes to kind:39701 with authors=<contact list>. When the
  // user follows or unfollows someone the contact-list store updates
  // and we re-derive the feed with the fresh author set.

  import { derived, type Readable, writable } from 'svelte/store';
  import Subheader from '$lib/components/Subheader.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { session } from '$lib/stores/session';
  import { followedPubkeys, contactList } from '$lib/nostr/contacts';

  // Re-create the feed whenever the followed set changes. Without this
  // the subscription would only ever cover the authors we knew about
  // when the page first mounted; following a new curator wouldn't
  // start streaming their bookmarks until a hard refresh.
  $: authorsArray = [...$followedPubkeys];
  $: feed = $session.pubkey && authorsArray.length > 0
    ? createBookmarkFeed({ authors: authorsArray, limit: 200 })
    : null;
  $: bookmarks = (feed ?? writable<ParsedBookmark[]>([])) as Readable<ParsedBookmark[]>;

  // Don't render the empty-state forever if the contact list is loading
  // — show a "loading" until it lands.
  $: contactsLoaded = $contactList.contacts.size > 0 || $contactList.baseEventId !== undefined;
</script>

<svelte:head><title>follows — Deepmarks</title></svelte:head>

<Subheader context="follows" />

{#if !$session.pubkey}
  <p class="hint">sign in to see bookmarks from people you follow.</p>
{:else if !contactsLoaded}
  <p class="hint">loading your follows…</p>
{:else if authorsArray.length === 0}
  <p class="hint">
    you're not following anyone yet. tap "follow" on any curator's bookmark or profile, or
    follow people you already follow on Damus / Primal — your kind:3 list flows through.
  </p>
{:else}
  <BookmarkList
    bookmarks={$bookmarks}
    loading={true}
    emptyMessage="your follows haven't bookmarked anything yet"
    freezeFeed={false}
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
