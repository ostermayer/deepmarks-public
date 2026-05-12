<script lang="ts">
  import { page } from '$app/stores';
  import { derived, type Readable } from 'svelte/store';
  import Subheader from '$lib/components/Subheader.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { ownBookmarks } from '$lib/stores/own-bookmarks';

  $: tag = $page.params.tag ?? '';
  $: scope = $page.url.searchParams.get('scope') === 'mine' ? 'mine' : 'network';
  $: ownTagged = derived(ownBookmarks, ($bookmarks) =>
    $bookmarks.filter((b) => b.tags.some((t) => t.toLowerCase() === tag.toLowerCase())),
  );
  $: feed = (scope === 'mine' ? ownTagged : createBookmarkFeed({ tags: [tag], limit: 200 })) as Readable<ParsedBookmark[]>;
</script>

<svelte:head><title>{scope === 'mine' ? 'my ' : ''}{tag} — Deepmarks</title></svelte:head>

<Subheader context={`${scope === 'mine' ? 'my tag' : 'tag'} · ${tag}`} />

<BookmarkList bookmarks={$feed} loading={true} emptyMessage={`no ${scope === 'mine' ? 'saved ' : ''}bookmarks tagged "${tag}" yet`} />
