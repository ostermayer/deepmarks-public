<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { derived } from 'svelte/store';
  import Subheader from '$lib/components/Subheader.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import { ownBookmarks, refreshOwnBookmarks } from '$lib/stores/own-bookmarks';

  $: tag = $page.params.tag ?? '';
  $: ownTagged = derived(ownBookmarks, ($bookmarks) =>
    $bookmarks.filter((b) => b.tags.some((t) => t.toLowerCase() === tag.toLowerCase())),
  );
  $: pageContext = `my tag · ${tag}`;
  $: emptyMessage = `no saved bookmarks tagged "${tag}" yet`;

  // When the tag page is the first surface the user lands on (e.g.
  // following a saved link straight to /app/tags/ai), the ownBookmarks
  // store may not have been hydrated yet. Kick the loader explicitly.
  onMount(() => {
    refreshOwnBookmarks();
  });
</script>

<svelte:head><title>my {tag} — Deepmarks</title></svelte:head>

<Subheader context={pageContext} />

<BookmarkList bookmarks={$ownTagged} loading={false} {emptyMessage} freezeFeed={false} />
