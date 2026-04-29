<script lang="ts">
  import { derived, type Readable } from 'svelte/store';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import { tagCloudFrom, type TagCloudItem } from '$lib/nostr/tag-cloud';

  // Live tag cloud derived from the network feed — bigger the more curators
  // have tagged a bookmark with it. The /tags page is an overview, so we
  // cast a wider net than the sidebar version (top 48 instead of 24).
  const feed = createBookmarkFeed({ limit: 500 });
  const cloud: Readable<TagCloudItem[]> = derived(feed, ($f) => tagCloudFrom($f, 48));
</script>

<svelte:head><title>tags — Deepmarks</title></svelte:head>

<div class="container">
  {#if $cloud.length === 0}
    <div class="empty">listening to relays…</div>
  {:else}
    <div class="cloud">
      {#each $cloud as t}
        <a href={`/app/tags/${encodeURIComponent(t.name)}`} class={`s${t.weight}`}>{t.name}</a>
      {/each}
    </div>
  {/if}
</div>

<style>
  .container { max-width: 1040px; margin: 0 auto; padding: 36px 24px; }
  .empty { color: var(--muted); font-size: 13px; padding: 40px 0; text-align: center; }
  .cloud { line-height: 2.4; }
  .cloud a { display: inline-block; margin-right: 14px; color: var(--link); }
  .cloud a:hover { color: var(--coral); text-decoration: none; }
  .cloud .s1 { font-size: 12px; color: var(--muted); }
  .cloud .s2 { font-size: 14px; }
  .cloud .s3 { font-size: 18px; font-weight: 600; }
  .cloud .s4 { font-size: 24px; font-weight: 600; }
  .cloud .s5 { font-size: 32px; font-weight: 700; color: var(--ink-deep); }
</style>
