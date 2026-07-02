<script lang="ts">
  import { onMount } from 'svelte';
  import { Plus, Search } from 'lucide-svelte';
  import { npub, session } from '$lib/stores/session';
  import AppSectionNav from '$lib/components/AppSectionNav.svelte';
  import {
    addBookmarkToCollection,
    createCollection,
    ownCollections,
    refreshOwnCollections,
  } from '$lib/nostr/collections';
  import {
    collectionSlugFromInput,
    type BookmarkCollection,
    type CollectionVisibility,
  } from '$lib/bookmark-collections';
  import { isPrivateBookmark } from '$lib/nostr/bookmark-privacy';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { searchLocalBookmarks } from '$lib/search/local-bookmark-search';
  import { canSign } from '$lib/stores/session';
  import { ownBookmarks, refreshOwnBookmarks } from '$lib/stores/own-bookmarks';

  let draftTitle = '';
  let draftVisibility: CollectionVisibility = 'public';
  let selectedCollectionSlug = '';
  let builderQuery = '';
  let builderError = '';
  let builderStatus = '';
  let creating = false;
  let addingUrl = '';

  onMount(() => {
    refreshOwnBookmarks();
    const pubkey = $session.pubkey;
    if (pubkey) void refreshOwnCollections(pubkey);
  });

  $: collections = $ownCollections;
  $: publicCollections = collections.filter((collection) => collection.publicCount > 0);
  $: privateCollections = collections.filter((collection) => collection.privateCount > 0);
  $: if (selectedCollectionSlug && !collections.some((collection) => collection.slug === selectedCollectionSlug)) {
    selectedCollectionSlug = '';
  }
  $: selectedCollection = collections.find((collection) => collection.slug === selectedCollectionSlug) ?? null;
  $: activeBuilderQuery = builderQuery.trim();
  $: builderResults = activeBuilderQuery
    ? searchLocalBookmarks($ownBookmarks, activeBuilderQuery, { limit: 24 })
    : [];
  $: draftSlug = collectionSlugFromInput(draftTitle);
  $: createDisabled = creating || !draftSlug || !$canSign;

  function collectionHref(slug: string): string {
    return `/app/collections/${encodeURIComponent(slug)}`;
  }

  function publicHref(slug: string): string {
    return $npub ? `/u/${$npub}/${encodeURIComponent(slug)}` : '';
  }

  async function createDraftCollection(): Promise<void> {
    builderError = '';
    builderStatus = '';
    const pubkey = $session.pubkey;
    if (!pubkey || !$canSign) {
      builderError = 'connect your signer to create collections';
      return;
    }
    creating = true;
    try {
      const result = await createCollection(draftTitle, pubkey, {
        visibility: draftVisibility,
        title: draftTitle,
      });
      selectedCollectionSlug = result.collection.slug;
      draftTitle = '';
      await result.publish;
      builderStatus = 'collection created';
    } catch (e) {
      builderError = (e as Error).message || 'could not create collection';
    } finally {
      creating = false;
    }
  }

  async function addBookmark(bookmark: ParsedBookmark): Promise<void> {
    builderError = '';
    builderStatus = '';
    const pubkey = $session.pubkey;
    if (!pubkey || !$canSign) {
      builderError = 'connect your signer to update collections';
      return;
    }
    const target = selectedCollection ?? draftTitle.trim();
    if (!target) {
      builderError = 'select or name a collection first';
      return;
    }
    addingUrl = bookmark.url;
    try {
      const result = await addBookmarkToCollection(bookmark, target, pubkey, {
        visibility: selectedCollection?.visibility ?? draftVisibility,
        title: draftTitle.trim() || selectedCollection?.title,
      });
      selectedCollectionSlug = result.collection.slug;
      if (!selectedCollection) draftTitle = '';
      await result.publish;
      builderStatus = 'bookmark added';
    } catch (e) {
      builderError = (e as Error).message || 'could not add bookmark';
    } finally {
      addingUrl = '';
    }
  }

  function bookmarkHost(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  function bookmarkInSelectedCollection(bookmark: ParsedBookmark): boolean {
    return !!selectedCollection && selectedCollection.urls.includes(bookmark.url);
  }

  function countLabel(collection: BookmarkCollection): string {
    if (collection.privateCount > 0) {
      return `${collection.publicCount.toLocaleString()} public · ${collection.privateCount.toLocaleString()} private`;
    }
    return `${collection.publicCount.toLocaleString()} public`;
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

  <section class="builder" aria-label="collection builder">
    <div class="builder-controls">
      <form class="create-form" on:submit|preventDefault={() => void createDraftCollection()}>
        <label>
          <span>new collection</span>
          <input
            type="text"
            bind:value={draftTitle}
            placeholder="research queue"
            autocomplete="off"
          />
        </label>
        <label>
          <span>visibility</span>
          <select bind:value={draftVisibility}>
            <option value="public">public</option>
            <option value="private">private</option>
          </select>
        </label>
        <button type="submit" disabled={createDisabled}>
          <Plus size={15} strokeWidth={2.2} />
          <span>{creating ? 'creating...' : 'create'}</span>
        </button>
      </form>

      <div class="add-controls">
        <label>
          <span>add to</span>
          <select bind:value={selectedCollectionSlug}>
            <option value="">new collection above</option>
            {#each collections as collection (collection.slug)}
              <option value={collection.slug}>{collection.title}</option>
            {/each}
          </select>
        </label>
        <label class="search-field">
          <span>find bookmarks</span>
          <span class="search-input">
            <Search size={15} strokeWidth={2.2} />
            <input
              type="search"
              bind:value={builderQuery}
              placeholder="search title, tag, site..."
            />
          </span>
        </label>
      </div>
    </div>

    {#if builderError}
      <p class="builder-message error" aria-live="polite">{builderError}</p>
    {:else if builderStatus}
      <p class="builder-message" aria-live="polite">{builderStatus}</p>
    {/if}

    {#if activeBuilderQuery}
      {#if builderResults.length === 0}
        <p class="builder-empty">no matches for <code>{activeBuilderQuery}</code></p>
      {:else}
        <div class="result-list">
          {#each builderResults as bookmark (bookmark.eventId)}
            {@const alreadyInTarget = bookmarkInSelectedCollection(bookmark)}
            <article class="result-row">
              <div class="result-main">
                <strong>{bookmark.title || bookmark.url}</strong>
                <span>{bookmarkHost(bookmark.url)} · {isPrivateBookmark(bookmark) ? 'private' : 'public'}</span>
              </div>
              <button
                type="button"
                disabled={alreadyInTarget || !!addingUrl || (!$canSign)}
                on:click={() => void addBookmark(bookmark)}
              >
                <Plus size={14} strokeWidth={2.2} />
                <span>
                  {#if alreadyInTarget}
                    added
                  {:else if addingUrl === bookmark.url}
                    adding...
                  {:else}
                    add
                  {/if}
                </span>
              </button>
            </article>
          {/each}
        </div>
      {/if}
    {/if}
  </section>

  {#if collections.length === 0}
    <p class="empty">no collections yet.</p>
  {:else}
    <div class="collection-grid">
      {#each collections as collection (collection.slug)}
        <article class="collection-card">
          <a class="collection-main-link" href={collectionHref(collection.slug)}>
            <span class="collection-name">{collection.title}</span>
            <span class="collection-count">{countLabel(collection)}</span>
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
  .builder {
    display: grid;
    gap: 12px;
    margin-bottom: 24px;
    padding: 16px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--surface);
  }
  .builder-controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
    gap: 14px;
    align-items: end;
  }
  .create-form,
  .add-controls {
    display: grid;
    grid-template-columns: minmax(150px, 1fr) minmax(112px, 140px) auto;
    gap: 10px;
    align-items: end;
  }
  .add-controls {
    grid-template-columns: minmax(150px, 180px) minmax(220px, 1fr);
  }
  label {
    display: grid;
    gap: 5px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }
  input,
  select {
    min-width: 0;
    height: 36px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    padding: 0 10px;
  }
  input:focus,
  select:focus {
    outline: 2px solid var(--coral-soft);
    border-color: var(--coral);
  }
  .search-input {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 7px;
    height: 36px;
    padding: 0 10px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--paper);
    color: var(--muted);
  }
  .search-input input {
    height: auto;
    border: 0;
    border-radius: 0;
    background: transparent;
    padding: 0;
  }
  .search-input:focus-within {
    outline: 2px solid var(--coral-soft);
    border-color: var(--coral);
  }
  .create-form button,
  .result-row button {
    height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--paper-warm);
    color: var(--ink-deep);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .create-form button:hover,
  .result-row button:hover {
    border-color: var(--coral);
    color: var(--coral-deep);
  }
  .create-form button:disabled,
  .result-row button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .builder-message,
  .builder-empty {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }
  .builder-message.error {
    color: var(--coral-deep);
  }
  .result-list {
    display: grid;
    border-top: 1px solid var(--rule);
  }
  .result-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
    padding: 10px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--rule) 70%, transparent);
  }
  .result-row:last-child {
    border-bottom: 0;
    padding-bottom: 0;
  }
  .result-main {
    min-width: 0;
    display: grid;
    gap: 3px;
  }
  .result-main strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-deep);
    font-size: 13px;
    font-weight: 600;
  }
  .result-main span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 12px;
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
    .builder-controls,
    .create-form,
    .add-controls,
    .result-row {
      grid-template-columns: 1fr;
    }
    .result-row button {
      width: 100%;
    }
  }
</style>
