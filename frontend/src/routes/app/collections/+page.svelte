<script lang="ts">
  import { onMount } from 'svelte';
  import { npub, session } from '$lib/stores/session';
  import AppSectionNav from '$lib/components/AppSectionNav.svelte';
  import { ownCollections, refreshOwnCollections } from '$lib/nostr/collections';
  import { ownBookmarks, refreshOwnBookmarks } from '$lib/stores/own-bookmarks';

  onMount(() => {
    refreshOwnBookmarks();
    const pubkey = $session.pubkey;
    if (pubkey) void refreshOwnCollections(pubkey);
  });

  $: collections = $ownCollections;
  $: publicCollections = collections.filter((collection) => collection.publicCount > 0);
  $: privateCollections = collections.filter((collection) => collection.privateCount > 0);

  function collectionHref(slug: string): string {
    return `/app/collections/${encodeURIComponent(slug)}`;
  }

  function publicHref(slug: string): string {
    return $npub ? `/u/${$npub}/${encodeURIComponent(slug)}` : '';
  }
</script>

<svelte:head><title>collections — Deepmarks</title></svelte:head>

<AppSectionNav
  active="collections"
  bookmarksCount={$ownBookmarks.length}
  collectionsCount={collections.length}
/>

<main class="collections-page">
  <header class="page-head">
    <h1>collections</h1>
    <p>{publicCollections.length.toLocaleString()} public · {privateCollections.length.toLocaleString()} private</p>
  </header>

  {#if collections.length === 0}
    <p class="empty">no collections yet. add a bookmark to a collection from any bookmark row.</p>
  {:else}
    <div class="collection-grid">
      {#each collections as collection (collection.slug)}
        <article class="collection-card">
          <a class="collection-main-link" href={collectionHref(collection.slug)}>
            <span class="collection-name">{collection.title}</span>
            <span class="collection-count">
              {#if collection.privateCount > 0}
                {collection.publicCount.toLocaleString()} public · {collection.privateCount.toLocaleString()} private
              {:else}
                {collection.publicCount.toLocaleString()} public
              {/if}
            </span>
          </a>
          <div class="collection-actions">
            <a href={collectionHref(collection.slug)}>open</a>
            {#if publicHref(collection.slug)}
              <a href={publicHref(collection.slug)}>public page</a>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/if}
</main>

<style>
  .collections-page {
    max-width: 1080px;
    margin: 0 auto;
    padding: 32px 24px 48px;
  }
  .page-head {
    margin-bottom: 22px;
  }
  h1 {
    margin: 0;
    color: var(--ink-deep);
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 26px;
    font-weight: 600;
    letter-spacing: 0;
  }
  .page-head p,
  .empty {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 13px;
  }
  .empty {
    padding: 28px 0;
  }
  .collection-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 12px;
  }
  .collection-card {
    display: grid;
    gap: 10px;
    padding: 14px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--surface);
  }
  .collection-main-link {
    display: grid;
    gap: 4px;
    color: var(--ink);
    text-decoration: none;
  }
  .collection-main-link:hover {
    color: var(--coral);
    text-decoration: none;
  }
  .collection-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-deep);
    font-size: 16px;
    font-weight: 600;
  }
  .collection-count {
    color: var(--muted);
    font-size: 12px;
  }
  .collection-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 12px;
  }
  .collection-actions a {
    color: var(--link);
  }
  @media (max-width: 720px) {
    .collections-page {
      padding: 22px 18px calc(96px + env(safe-area-inset-bottom, 0px));
    }
  }
</style>
