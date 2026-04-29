<script lang="ts">
  import { page } from '$app/stores';
  import Subheader from '$lib/components/Subheader.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import { createBookmarkFeed } from '$lib/nostr/feed';

  $: tag = $page.params.tag ?? '';
  $: feed = createBookmarkFeed({ tags: [tag], limit: 200 });
</script>

<svelte:head><title>{tag} — Deepmarks</title></svelte:head>

<Subheader context={`tag · ${tag}`} />

<BookmarkList bookmarks={$feed} loading={true} emptyMessage={`no bookmarks tagged "${tag}" yet`} />
