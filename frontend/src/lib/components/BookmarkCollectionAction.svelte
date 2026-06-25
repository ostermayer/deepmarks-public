<script lang="ts">
  import { onMount } from 'svelte';
  import { collectionSlugFromInput, type BookmarkCollection, type CollectionVisibility } from '$lib/bookmark-collections';
  import { addBookmarkToCollection, ownCollections, refreshOwnCollections } from '$lib/nostr/add-to-collection';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { canSign, session } from '$lib/stores/session';

  export let bookmark: ParsedBookmark;

  let open = false;
  let draft = '';
  let draftVisibility: CollectionVisibility = 'public';
  let workingSlug = '';
  let error = '';

  onMount(() => {
    const pubkey = $session.pubkey;
    if (pubkey) void refreshOwnCollections(pubkey);
  });

  $: currentCollectionSlugs = new Set($ownCollections
    .filter((collection) => collection.urls.includes(bookmark.url))
    .map((collection) => collection.slug));
  $: availableCollections = $ownCollections
    .filter((collection) => !currentCollectionSlugs.has(collection.slug))
    .slice(0, 8);

  function addExisting(collection: BookmarkCollection): void {
    void addCollection(collection);
  }

  function addDraft(): void {
    void addCollection(draft, draftVisibility);
  }

  async function addCollection(input: string | BookmarkCollection, visibility?: CollectionVisibility): Promise<void> {
    error = '';
    const pubkey = $session.pubkey;
    if (!pubkey || !$canSign) {
      error = 'connect your signer to update collections';
      return;
    }
    const slug = collectionSlugFromInput(typeof input === 'string' ? input : input.slug);
    if (!slug) {
      error = 'enter a collection name';
      return;
    }
    workingSlug = slug;
    try {
      const result = await addBookmarkToCollection(bookmark, input, pubkey, { visibility });
      draft = '';
      await result.publish;
      open = false;
    } catch (e) {
      error = (e as Error).message || 'could not update collection';
    } finally {
      workingSlug = '';
    }
  }
</script>

<span class="collection-action">
  <button
    type="button"
    class="collection-trigger"
    class:active={open}
    aria-expanded={open}
    on:click={() => {
      open = !open;
      error = '';
    }}
  >
    collection
  </button>
  {#if open}
    <span class="collection-pop" role="dialog" aria-label="add to collection">
      {#if currentCollectionSlugs.size > 0}
        <span class="current-label">in {currentCollectionSlugs.size} collection{currentCollectionSlugs.size === 1 ? '' : 's'}</span>
      {/if}
      {#if availableCollections.length > 0}
        <span class="collection-options">
          {#each availableCollections as collection (collection.slug)}
            <button
              type="button"
              on:click={() => addExisting(collection)}
              disabled={!!workingSlug}
            >
              {workingSlug === collection.slug ? 'adding...' : collection.title}
            </button>
          {/each}
        </span>
      {/if}
      <span class="new-row">
        <input
          type="text"
          bind:value={draft}
          placeholder="new collection"
          disabled={!!workingSlug}
          on:keydown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addDraft();
            }
          }}
        />
        <select bind:value={draftVisibility} disabled={!!workingSlug} aria-label="collection visibility">
          <option value="public">public</option>
          <option value="private">private</option>
        </select>
        <button type="button" on:click={addDraft} disabled={!!workingSlug || !draft.trim()}>
          add
        </button>
      </span>
      {#if error}<span class="collection-error">{error}</span>{/if}
    </span>
  {/if}
</span>

<style>
  .collection-action {
    position: relative;
    display: inline-flex;
  }
  .collection-trigger {
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--link);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
  }
  .collection-trigger:hover,
  .collection-trigger.active {
    color: var(--coral);
  }
  .collection-pop {
    position: absolute;
    left: 0;
    top: calc(100% + 7px);
    z-index: 72;
    width: min(280px, 82vw);
    display: grid;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink);
    box-shadow: 0 12px 28px var(--shadow);
  }
  .collection-pop::before {
    content: '';
    position: absolute;
    left: 14px;
    top: -6px;
    width: 10px;
    height: 10px;
    border-left: 1px solid var(--rule);
    border-top: 1px solid var(--rule);
    background: var(--surface);
    transform: rotate(45deg);
  }
  .current-label {
    color: var(--muted);
    font-size: 11px;
  }
  .collection-options {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .collection-options button,
  .new-row button {
    border: 1px solid var(--rule);
    border-radius: 999px;
    background: var(--paper-warm);
    color: var(--ink);
    padding: 4px 9px;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .collection-options button:hover,
  .new-row button:hover {
    border-color: var(--coral);
    color: var(--coral-deep);
  }
  .collection-options button:disabled,
  .new-row button:disabled,
  .new-row input:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .new-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 6px;
  }
  .new-row input,
  .new-row select {
    min-width: 0;
    border: 1px solid var(--rule);
    border-radius: 7px;
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-size: 12px;
    padding: 6px 8px;
  }
  .new-row select {
    max-width: 88px;
  }
  .new-row input:focus,
  .new-row select:focus {
    outline: 2px solid var(--coral-soft);
    border-color: var(--coral);
  }
  .collection-error {
    color: var(--coral-deep);
    font-size: 11px;
    line-height: 1.35;
  }
  @media (max-width: 720px) {
    .collection-pop {
      position: fixed;
      left: 14px;
      right: 14px;
      top: auto;
      bottom: calc(76px + env(safe-area-inset-bottom, 0px));
      width: auto;
      max-height: min(360px, calc(100dvh - 120px));
      overflow: auto;
      z-index: 42;
      padding: 12px;
    }
    .collection-pop::before {
      display: none;
    }
    .collection-options button,
    .new-row button {
      min-height: 34px;
    }
    .new-row input,
    .new-row select {
      min-height: 36px;
      font-size: 16px;
    }
    .new-row {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .new-row select {
      grid-column: 1 / 2;
      max-width: none;
    }
  }
</style>
