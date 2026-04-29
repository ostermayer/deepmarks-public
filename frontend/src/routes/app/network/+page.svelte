<script lang="ts">
  import Subheader from '$lib/components/Subheader.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import { createBookmarkFeed } from '$lib/nostr/feed';

  // Live subscription: every kind:39701 from anyone, newest first.
  const feed = createBookmarkFeed({ limit: 200 });
</script>

<svelte:head><title>network — Deepmarks</title></svelte:head>

<Subheader
  sorts={[
    { label: 'recent', href: '#', current: true },
    { label: 'popular', href: '/app/popular' },
    { label: '⚡ most sats', href: '#' },
    { label: 'archived only', href: '#' }
  ]}
/>

<BookmarkList bookmarks={$feed} loading={true} emptyMessage="no public bookmarks yet — be first" />
