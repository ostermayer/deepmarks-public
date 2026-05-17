<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { derived, type Readable } from 'svelte/store';
  import Subheader from '$lib/components/Subheader.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { ownBookmarks, refreshOwnBookmarks } from '$lib/stores/own-bookmarks';

  $: tag = $page.params.tag ?? '';
  $: scope = $page.url.searchParams.get('scope') === 'mine' ? 'mine' : 'network';
  $: ownTagged = derived(ownBookmarks, ($bookmarks) =>
    $bookmarks.filter((b) => b.tags.some((t) => t.toLowerCase() === tag.toLowerCase())),
  );
  $: feed = (scope === 'mine' ? ownTagged : createBookmarkFeed({ tags: [tag], limit: 200 })) as Readable<ParsedBookmark[]>;

  // When the tag page is the first surface the user lands on (e.g.
  // following a saved link straight to /app/tags/ai), the
  // ownBookmarks store may not have been hydrated yet — the loader
  // is a soft-start that other pages trigger on mount. Without this,
  // the user sees "no bookmarks tagged X" until they refresh, even
  // though their cache holds the data. Kick the loader explicitly.
  onMount(() => {
    refreshOwnBookmarks();
  });
</script>

<svelte:head><title>{scope === 'mine' ? 'my ' : ''}{tag} — Deepmarks</title></svelte:head>

<Subheader context={`${scope === 'mine' ? 'my tag' : 'tag'} · ${tag}`} />

<BookmarkList bookmarks={$feed} loading={true} emptyMessage={`no ${scope === 'mine' ? 'saved ' : ''}bookmarks tagged "${tag}" yet`} />
