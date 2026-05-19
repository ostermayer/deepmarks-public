<script lang="ts">
  // /app/url/[url] — every curator who has saved this URL.
  //
  // The canonical Pinboard surface ("everyone who saved foo.com/bar")
  // and our best SEO/discoverability page. The link in BookmarkCard's
  // "<N> others saved this" used to 404 here; now it lands on a real
  // feed showing all kind:39701 events with `d=<url>` from any author.
  // Aggregates tags + total saves + total zaps so the page itself
  // doubles as a per-URL summary.

  import { onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { writable, derived, type Readable } from 'svelte/store';
  import Subheader from '$lib/components/Subheader.svelte';
  import BookmarkList from '$lib/components/BookmarkList.svelte';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';

  // SvelteKit auto-decodes the param. Each save of the same URL is a
  // separate kind:39701 from a different author addressed by `d=<url>`.
  // Cast through Record<string,string> because the generated type for
  // dynamic-segment params doesn't reach this file in adapter-static
  // builds.
  $: url = ($page.params as Record<string, string>).url ?? '';

  // Subscribe with a `#d=<url>` filter so we only get events for this
  // specific URL. No author restriction — this is the social view.
  $: feed = url
    ? createBookmarkFeed({ urls: [url], limit: 200 })
    : null;

  $: bookmarks = (feed ?? writable<ParsedBookmark[]>([])) as Readable<ParsedBookmark[]>;

  $: totalSavers = new Set($bookmarks.map((b) => b.curator)).size;
  $: aggregateTags = aggregate($bookmarks);

  function aggregate(list: ParsedBookmark[]): { tag: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const b of list) {
      for (const t of b.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 12);
  }

  let hostName = '';
  $: try { hostName = url ? new URL(url).hostname.replace(/^www\./, '') : ''; } catch { hostName = ''; }

  void onDestroy;  // re-export ceremony — feed cleanup handled inside createBookmarkFeed
</script>

<svelte:head><title>{hostName ? `${hostName} — Deepmarks` : 'URL — Deepmarks'}</title></svelte:head>

<Subheader context={hostName ? `url · ${hostName}` : 'url'} />

<div class="header">
  <div class="meta">
    <a href={url} target="_blank" rel="noreferrer" class="big-url">{url}</a>
    {#if totalSavers > 0}
      <div class="savers">
        <span class="num-retro">{totalSavers}</span>
        {totalSavers === 1 ? 'person has' : 'people have'} saved this
      </div>
    {/if}
    {#if aggregateTags.length > 0}
      <div class="agg-tags">
        {#each aggregateTags as t (t.tag)}
          <a href={`/app/tags/${encodeURIComponent(t.tag)}`} class="tag-chip">
            #{t.tag}<span class="muted"> · {t.count}</span>
          </a>
        {/each}
      </div>
    {/if}
  </div>
</div>

<BookmarkList
  bookmarks={$bookmarks}
  loading={true}
  emptyMessage={url ? 'no one has saved this URL yet' : 'no URL specified'}
  freezeFeed={false}
/>

<style>
  .header {
    max-width: 1040px;
    margin: 0 auto;
    padding: 18px 24px 12px;
  }
  .big-url {
    display: block;
    font-family: 'Courier New', monospace;
    color: var(--ink-deep);
    word-break: break-all;
    font-size: 14px;
    margin-bottom: 12px;
  }
  .savers {
    color: var(--muted);
    font-size: 13px;
    margin-bottom: 12px;
  }
  .agg-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .tag-chip {
    background: var(--paper-warm);
    color: var(--ink-deep);
    padding: 3px 10px;
    border-radius: 100px;
    font-size: 12px;
    text-decoration: none;
  }
  .tag-chip:hover { background: var(--coral-soft); color: var(--coral-deep); }
  .tag-chip .muted { color: var(--muted); }
</style>
