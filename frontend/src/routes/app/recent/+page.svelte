<script lang="ts">
  import Subheader from '$lib/components/Subheader.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import { createBookmarkFeed } from '$lib/nostr/feed';

  // Same source as network — feed is already sorted newest-first.
  const feed = createBookmarkFeed({ limit: 200 });
</script>

<svelte:head><title>recent — Deepmarks</title></svelte:head>

<Subheader context="global · recent" />

<BookmarkList bookmarks={$feed} loading={true} freezeTagCloud={true} emptyMessage="no recent bookmarks yet" />
