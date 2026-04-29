<script lang="ts">
  // Compact bookmark row for the landing page + Recent/Popular lists.
  // Shows: site favicon, title, host · time-ago · by [name] · save-count? · save-link.
  // Click on the title opens the URL in a new tab; click on "save" opens
  // QuickSaveDialog pre-filled with the URL, title, and tags. The curator's
  // identicon + lifetime badge live on their profile page, not on each row.

  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { relativeTime } from '$lib/util/time';
  import { getProfile } from '$lib/nostr/profiles';
  import { session } from '$lib/stores/session';
  import { nip19 } from 'nostr-tools';
  import { config } from '$lib/config';
  import Favicon from './Favicon.svelte';
  import QuickSaveDialog from './QuickSaveDialog.svelte';
  import BookmarkEditForm from './BookmarkEditForm.svelte';

  /** Best-available URL to *view* the archive for this bookmark. Prefers
   *  our Blossom mirror (we always keep a copy); falls back to wayback
   *  for wayback-only bookmarks. Returns null when we have nothing. */
  function archiveHref(b: ParsedBookmark): string | null {
    if (b.blossomHash) return `${config.blossomUrl.replace(/\/$/, '')}/${b.blossomHash}`;
    if (b.waybackUrl) return b.waybackUrl;
    return null;
  }

  export let bookmark: ParsedBookmark;
  /** Optional save-count badge, set when this row comes from the popular feed. */
  export let saveCount: number | undefined = undefined;

  let saveOpen = false;
  let editing = false;
  /** Soft-hide the row after the user deletes it — the feed store will
   *  eventually reconcile when the kind:5 propagates, but this gives
   *  instant feedback. */
  let hidden = false;
  $: isOwner = $session.pubkey === bookmark.curator;
  $: profile = getProfile(bookmark.curator);
  $: curatorLabel = resolveLabel($profile?.displayName, bookmark.curator);
  $: curatorHref = (() => {
    try { return `/u/${nip19.npubEncode(bookmark.curator)}`; }
    catch { return `/u/${bookmark.curator}`; }
  })();

  function resolveLabel(displayName: string | undefined, pubkey: string): string {
    if (displayName) return displayName;
    try {
      const n = nip19.npubEncode(pubkey);
      return `${n.slice(0, 10)}…`;
    } catch {
      return pubkey.slice(0, 8);
    }
  }

  function prettyHost(url: string): string {
    try {
      const u = new URL(url);
      return u.host.replace(/^www\./, '');
    } catch {
      // Non-http URLs (nostr: URIs, etc.) can't be parsed — truncate so
      // a very long value doesn't overflow the column.
      return url.length > 40 ? `${url.slice(0, 37)}…` : url;
    }
  }

  function onSaveClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    saveOpen = true;
  }
</script>

{#if !hidden}
<div class="row" class:is-private={bookmark.eventId.startsWith('private:')}>
  <Favicon url={bookmark.url} size={22} />
  <div class="body">
    <a class="title" href={bookmark.url} target="_blank" rel="noreferrer">{bookmark.title}</a>
    <div class="meta">
      {#if bookmark.eventId.startsWith('private:')}
        <span class="vis-tag private" title="private — only you can see this">🔒 private</span>
        <span class="dot">·</span>
      {/if}
      <span class="host">{prettyHost(bookmark.url)}</span>
      <span class="dot">·</span>
      <span class="when">{relativeTime(bookmark.savedAt)}</span>
      <span class="dot">·</span>
      <a class="by" href={curatorHref}>by {curatorLabel}</a>
      {#if saveCount !== undefined && saveCount > 1}
        <span class="dot">·</span>
        <span class="saves"><span class="num-retro">{saveCount}</span> saves</span>
      {/if}
    </div>
  </div>
  {#if archiveHref(bookmark)}
    <a
      class="archive-link"
      href={archiveHref(bookmark) ?? '#'}
      target="_blank"
      rel="noreferrer"
      title="view the archived snapshot"
    >📦</a>
  {:else if bookmark.archivedForever}
    <span class="archive-link" title="archived forever — snapshot not yet linked on this event">📦</span>
  {/if}
  {#if isOwner}
    <button
      class="edit-link"
      type="button"
      title={editing ? 'close the editor' : 'edit bookmark'}
      on:click|stopPropagation={() => (editing = !editing)}
    >{editing ? '×' : '✎'}</button>
  {/if}
  <button class="save-link" type="button" on:click={onSaveClick}>save</button>
</div>
{#if editing && isOwner}
  <div class="edit-wrap">
    <BookmarkEditForm
      {bookmark}
      on:cancel={() => (editing = false)}
      on:updated={() => (editing = false)}
      on:deleted={() => { hidden = true; editing = false; }}
    />
  </div>
{/if}
{/if}

<QuickSaveDialog
  bind:open={saveOpen}
  url={bookmark.url}
  initialTitle={bookmark.title}
  initialDescription={bookmark.description}
  initialTags={bookmark.tags}
  on:close={() => (saveOpen = false)}
/>

<style>
  .row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 0;
    border-bottom: 1px dashed var(--rule);
  }
  .row:last-child {
    border-bottom: 0;
  }
  .row.is-private {
    background: rgba(255, 107, 90, 0.04);
    border-left: 2px solid var(--coral);
    padding-left: 10px;
    margin-left: -12px;
    border-radius: 4px;
  }
  .vis-tag {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 600;
  }
  .vis-tag.private {
    color: var(--coral-deep);
  }
  .edit-wrap {
    padding: 0 0 14px;
    border-bottom: 1px dashed var(--rule);
    margin-bottom: -1px;
  }
  .body {
    flex: 1;
    min-width: 0;
  }
  .title {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink-deep);
    line-height: 1.3;
    margin-bottom: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-decoration: none;
  }
  .title:hover {
    color: var(--coral);
    text-decoration: none;
  }
  .meta {
    font-size: 11px;
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
    max-width: 100%;
  }
  .host {
    font-family: 'Courier New', monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
    min-width: 0;
  }
  .dot {
    color: var(--rule);
  }
  .by {
    color: var(--ink);
    text-decoration: none;
  }
  .by:hover {
    color: var(--coral);
    text-decoration: underline;
  }
  .saves {
    color: var(--coral-deep);
    font-weight: 500;
  }
  .save-link {
    align-self: center;
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 4px 12px;
    border-radius: 100px;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .save-link:hover {
    border-color: var(--coral);
    color: var(--coral);
  }
  .archive-link {
    align-self: center;
    font-size: 14px;
    line-height: 1;
    padding: 4px 6px;
    text-decoration: none;
    color: var(--archive);
    flex-shrink: 0;
  }
  .archive-link:hover {
    transform: scale(1.12);
    text-decoration: none;
  }
  .edit-link {
    align-self: center;
    background: transparent;
    border: 0;
    font: inherit;
    font-size: 14px;
    line-height: 1;
    padding: 4px 6px;
    color: var(--muted);
    cursor: pointer;
    flex-shrink: 0;
  }
  .edit-link:hover {
    color: var(--coral);
  }
</style>
