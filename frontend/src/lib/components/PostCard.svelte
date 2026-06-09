<script lang="ts">
  // Owner's view of a bookmarked Nostr post (kind:1). Wraps NoteCard for
  // the rich note display and adds the same bookmark actions web URL
  // bookmarks get: tags (view + edit), read-later, archive, download,
  // zap, and share.
  //
  // A post is a reference to someone else's note, so the user's tags /
  // read-later / archive can't live on the note. They attach to a
  // Deepmarks-native bookmark keyed by the note's canonical URL
  // (nostrNoteArchiveUrl). If the user already has such a bookmark
  // (`ownBookmark`), actions edit it in place; otherwise the first
  // tag / read-later / archive "adopts" the post by publishing one.
  //
  // Adopt visibility = preserve-origin: a post that came from the user's
  // private NIP-51 list becomes a private bookmark; a public-origin post
  // follows their default-visibility setting. We never silently make a
  // privately-bookmarked post public.

  import { createEventDispatcher } from 'svelte';
  import { Archive, Download } from 'lucide-svelte';
  import NoteCard from './NoteCard.svelte';
  import BookmarkEditForm from './BookmarkEditForm.svelte';
  import ZapDialog from './ZapDialog.svelte';
  import PostToNostrAction from './PostToNostrAction.svelte';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { isImportedUrlBookmark } from '$lib/nostr/imported-bookmarks';
  import type { ArchiveRecord } from '$lib/api/client';
  import { canSign, session } from '$lib/stores/session';
  import { userSettings } from '$lib/stores/user-settings';
  import { myArchives } from '$lib/stores/my-archives';
  import { getLifetimeStatus } from '$lib/nostr/lifetime-status';
  import { toggleReadLater } from '$lib/nostr/toggle-read-later';
  import { enqueueArchivePage } from '$lib/nostr/archive';
  import { resolveEvent } from '$lib/nostr/event-resolver';
  import { nostrNoteArchiveUrl } from '$lib/nostr/social-refs';
  import { isNativeShell } from '$lib/native/runtime';
  import {
    archiveBlobUrl,
    archiveMime,
    closeReservedArchiveWindow,
    downloadArchiveRecord,
    fetchArchiveBytes,
    openArchiveBlobUrl,
    reserveArchiveOpenWindow,
  } from '$lib/archives/download';

  /** Hex event id of the bookmarked note. */
  export let targetEventId: string;
  /** When the user saved this post (for archive bookkeeping + new bookmarks). */
  export let savedAt: number;
  export let zapSats = 0;
  /** Visibility of the source the post arrived from: a post imported from
   *  the user's private NIP-51 list is 'private'. Drives preserve-origin. */
  export let originVisibility: 'public' | 'private' = 'public';
  /** The user's existing Deepmarks bookmark for this note, if they've
   *  already saved/tagged it. Supplied by the list so we don't scan the
   *  whole bookmark set per card. */
  export let ownBookmark: ParsedBookmark | undefined = undefined;

  const dispatch = createEventDispatcher<{ invalid: { targetEventId: string; kind: number } }>();
  const nativeShell = isNativeShell();

  let editing = false;
  let togglingReadLater = false;
  let archiveError = '';
  let archiving = false;
  let downloadingArchive = false;
  let decryptingArchive = false;

  $: event = resolveEvent(targetEventId);
  // Only a resolved kind:1 renders — mirrors NoteCard so we never show an
  // orphaned action row under a missing/non-note target.
  $: isNote = $event?.kind === 1;

  $: noteUrl = nostrNoteArchiveUrl(targetEventId);
  $: defaultIsPrivate = $userSettings.defaultVisibility === 'private';
  // preserve-origin: private origin → private; public origin → default setting.
  // An imported bookmark carries its privacy in `visibility`, NOT in a
  // `private:` eventId prefix (that prefix is only on Deepmarks-native
  // private-set entries). Check both, or tagging an imported *private*
  // Nostr-URL bookmark would publish a public kind:39701 and leak it.
  $: targetIsPrivate = ownBookmark
    ? (ownBookmark.eventId.startsWith('private:') ||
       (isImportedUrlBookmark(ownBookmark) && ownBookmark.visibility === 'private'))
    : (originVisibility === 'private' || defaultIsPrivate);

  // Working bookmark the actions operate on: the real one if adopted,
  // else a synthetic stand-in whose eventId prefix routes a first action
  // to the right publish path (private: → encrypted set, else kind:39701).
  $: bookmark = buildWorkingBookmark(ownBookmark, noteUrl, targetIsPrivate, savedAt, $session.pubkey);

  $: visibleTags = bookmark ? bookmark.tags.filter((t) => t !== 'toread') : [];
  $: isReadLater = !!bookmark?.tags.includes('toread');

  $: lifetimeStatus = $session.pubkey ? getLifetimeStatus($session.pubkey) : null;
  $: isLifetime = !!(lifetimeStatus && $lifetimeStatus);

  // Archive lookup mirrors BookmarkCard: prefer the blossom hash baked
  // into the bookmark, fall back to the owner's /account archive index.
  // Key on the bookmark's own URL so an adopted post (whose saved URL
  // may differ in form from nostrNoteArchiveUrl) still finds its archive.
  $: archiveUrl = bookmark?.url ?? noteUrl;
  $: ownArchive = archiveUrl ? $myArchives.get(archiveUrl) : undefined;
  $: archiveBlobHash = bookmark?.blossomHash || ownArchive?.blobHash || null;
  $: isPrivateArchive = ownArchive?.tier === 'private';
  $: archiveHref = archiveBlobHash ? archiveBlobUrl(archiveBlobHash) : (bookmark?.waybackUrl ?? null);
  $: hasArchive = !!archiveHref || !!ownArchive;
  $: archiveDownloadRecord = resolveDownloadRecord(ownArchive, bookmark);

  let zapOpen = false;

  $: if ($event?.kind !== undefined && $event.kind !== 1) {
    dispatch('invalid', { targetEventId, kind: $event.kind });
  }

  function buildWorkingBookmark(
    existing: ParsedBookmark | undefined,
    url: string | null,
    isPrivate: boolean,
    when: number,
    pubkey: string | null,
  ): ParsedBookmark | null {
    if (existing) return existing;
    if (!url || !pubkey) return null;
    return {
      url,
      title: url,
      description: '',
      tags: [],
      archivedForever: false,
      savedAt: when,
      curator: pubkey,
      // Prefix routes the first edit/read-later to the right publish path
      // without pre-existing on a relay; a real id replaces it once saved.
      eventId: isPrivate ? `private:${url}` : `optimistic:${url}`,
    };
  }

  function resolveDownloadRecord(
    archive: ArchiveRecord | undefined,
    bm: ParsedBookmark | null,
  ): ArchiveRecord | null {
    if (archive) return archive;
    const url = bm?.url ?? noteUrl;
    if (!bm?.blossomHash || !url) return null;
    return {
      jobId: bm.eventId,
      url,
      blobHash: bm.blossomHash,
      tier: 'public',
      source: 'bookmark',
      archivedAt: bm.savedAt,
    };
  }

  function onToggleReadLater(): void {
    if (!$session.pubkey || !bookmark) return;
    let result;
    try {
      result = toggleReadLater(bookmark, $session.pubkey);
    } catch (e) {
      archiveError = (e as Error).message ?? 'could not update';
      return;
    }
    togglingReadLater = true;
    result.publish
      .catch((e) => { archiveError = (e as Error).message ?? 'could not update'; })
      .finally(() => { togglingReadLater = false; });
  }

  async function onArchive(): Promise<void> {
    const url = bookmark?.url ?? noteUrl;
    if (!$session.pubkey || !url) return;
    archiving = true;
    archiveError = '';
    try {
      // Only attach a real kind:39701 id — never a synthetic
      // `optimistic:`/`private:` placeholder (the archive API stores it verbatim).
      const realEventId = bookmark && /^[0-9a-f]{64}$/.test(bookmark.eventId) ? bookmark.eventId : undefined;
      await enqueueArchivePage({
        url,
        tier: targetIsPrivate ? 'private' : 'public',
        pubkey: $session.pubkey,
        eventId: targetIsPrivate ? undefined : realEventId,
        bookmarkSavedAt: savedAt,
        lifetime: isLifetime,
        mirrorUrls: $userSettings.backupBlossomServers,
        dedupe: true,
      });
    } catch (e) {
      archiveError = (e as Error).message ?? 'archive failed';
    } finally {
      archiving = false;
    }
  }

  async function onDownloadArchive(): Promise<void> {
    if (!archiveDownloadRecord) return;
    downloadingArchive = true;
    archiveError = '';
    try {
      await downloadArchiveRecord(archiveDownloadRecord, { pubkey: $session.pubkey });
    } catch (e) {
      archiveError = (e as Error).message ?? 'download failed';
    } finally {
      downloadingArchive = false;
    }
  }

  async function onOpenArchive(): Promise<void> {
    if (!ownArchive || !$session.pubkey) return;
    if (!isPrivateArchive) return; // public archives use the <a> href directly
    const reserved = reserveArchiveOpenWindow(ownArchive);
    decryptingArchive = true;
    archiveError = '';
    try {
      const bytes = await fetchArchiveBytes(ownArchive, { pubkey: $session.pubkey });
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: archiveMime(ownArchive) }));
      if (!openArchiveBlobUrl(url, ownArchive, reserved)) {
        URL.revokeObjectURL(url);
        throw new Error('archive decrypted, but the browser blocked opening it. Use download instead.');
      }
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      closeReservedArchiveWindow(reserved);
      archiveError = (e as Error).message ?? 'failed to decrypt';
    } finally {
      decryptingArchive = false;
    }
  }

  function tagHref(tag: string): string {
    return `/app/tags/${encodeURIComponent(tag)}`;
  }

  function forwardInvalid(e: CustomEvent<{ targetEventId: string; kind: number }>): void {
    dispatch('invalid', e.detail);
  }
</script>

{#if isNote}
  <div class="post-card" class:read-later={isReadLater}>
    <NoteCard {targetEventId} {zapSats} on:invalid={forwardInvalid} />

    {#if bookmark}
      <div class="post-meta">
        {#if isReadLater}
          <span class="meta-pill readlater-pill" title="saved for later reading">📖 read later</span>
        {/if}
        {#if visibleTags.length}
          <span class="tags">
            {#each visibleTags as t}
              <a href={tagHref(t)} class="tag">{t}</a>
            {/each}
          </span>
        {/if}
        <span class="privacy-chip" class:private={targetIsPrivate}>
          {targetIsPrivate ? 'private' : 'public'}
        </span>
      </div>

      <div class="post-actions">
        <button
          type="button"
          class="act zap"
          class:disabled={!$canSign}
          disabled={!$canSign}
          title={$canSign ? 'zap this post' : 'connect a signer to zap'}
          on:click={() => $canSign && (zapOpen = true)}
        >⚡ zap</button>

        <button
          type="button"
          class="act readlater-toggle"
          class:syncing={togglingReadLater}
          disabled={togglingReadLater}
          title={isReadLater ? 'mark as read' : 'save for later reading'}
          on:click={() => void onToggleReadLater()}
        >{isReadLater ? '✓ read' : '📖 read later'}</button>

        {#if hasArchive}
          {#if isPrivateArchive}
            <button
              type="button"
              class="act archive-act"
              disabled={decryptingArchive}
              title={decryptingArchive ? 'decrypting archive' : 'open archived snapshot'}
              on:click={() => void onOpenArchive()}
            ><Archive size={13} strokeWidth={2.2} /> {decryptingArchive ? 'opening…' : 'archive'}</button>
          {:else if archiveHref}
            <a
              class="act archive-act"
              href={archiveHref}
              target="_blank"
              rel="noreferrer"
              title="open archived snapshot"
            ><Archive size={13} strokeWidth={2.2} /> archive</a>
          {/if}
          {#if archiveDownloadRecord && !nativeShell}
            <button
              type="button"
              class="act"
              disabled={downloadingArchive}
              title="download the archived snapshot"
              on:click={() => void onDownloadArchive()}
            ><Download size={13} strokeWidth={2.2} /> {downloadingArchive ? 'downloading…' : 'download'}</button>
          {/if}
        {:else if isLifetime}
          <button
            type="button"
            class="act archive-act"
            disabled={archiving}
            title="archive this post forever"
            on:click={() => void onArchive()}
          ><Archive size={13} strokeWidth={2.2} /> {archiving ? 'queued…' : 'archive'}</button>
        {/if}

        {#if $session.pubkey}
          <PostToNostrAction {bookmark} />
        {/if}

        {#if $session.pubkey}
          <button
            type="button"
            class="act"
            on:click={() => (editing = !editing)}
            title={editing ? 'close the editor' : 'edit tags'}
          >{editing ? '× close' : '✎ tags'}</button>
        {/if}
      </div>

      {#if archiveError}
        <div class="post-error" aria-live="polite">↳ {archiveError}</div>
      {/if}

      {#if editing}
        <BookmarkEditForm
          {bookmark}
          isPrivate={targetIsPrivate}
          synthetic={!ownBookmark}
          archiveRecord={ownArchive}
          on:cancel={() => (editing = false)}
          on:updated={() => (editing = false)}
          on:deleted={() => (editing = false)}
        />
      {/if}
    {/if}
  </div>

  {#if bookmark}
    <ZapDialog
      {bookmark}
      bind:open={zapOpen}
      on:close={() => (zapOpen = false)}
    />
  {/if}
{/if}

<style>
  .post-card {
    border-bottom: 1px solid color-mix(in srgb, var(--ink) 22%, var(--rule));
    padding: 4px 0 10px;
  }
  .post-card.read-later {
    background: var(--toread-tint);
    border-left: 3px solid var(--toread-accent);
    padding-left: 10px;
    margin-left: -13px;
    padding-right: 10px;
    margin-right: -10px;
  }
  .post-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    margin: 2px 0 0 38px;
    font-size: 11px;
    color: var(--muted);
  }
  .tags {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }
  .tag {
    display: inline-block;
    background: var(--surface);
    border: 1px solid var(--rule);
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 10px;
    color: var(--link) !important;
    text-decoration: none;
  }
  .tag:hover {
    background: var(--paper-warmer);
    border-color: var(--link);
  }
  .readlater-pill {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 10px;
    background: var(--toread-accent);
    color: #1a0f0c;
    font-size: 10px;
    font-weight: 600;
  }
  .privacy-chip {
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0 7px;
    border-radius: 999px;
    background: var(--paper-warm);
    border: 1px solid var(--rule);
    color: var(--ink);
  }
  .privacy-chip.private {
    background: rgba(255, 107, 90, 0.08);
    border-color: var(--coral-soft);
    color: var(--coral-deep);
  }
  .post-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    margin: 6px 0 0 38px;
    padding-top: 6px;
    border-top: 1px dashed var(--rule);
  }
  .act {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    border: 0;
    padding: 0;
    font: inherit;
    font-size: 11px;
    color: var(--link);
    cursor: pointer;
    text-decoration: none;
  }
  .act:hover { color: var(--coral); }
  .act:disabled { color: var(--muted); cursor: progress; }
  .act :global(svg) { display: block; }
  .zap {
    color: var(--zap);
    font-weight: 600;
  }
  .zap:hover { color: #d97706; }
  .zap.disabled { opacity: 0.5; cursor: not-allowed; }
  .readlater-toggle {
    color: var(--toread-accent);
    font-weight: 600;
  }
  .readlater-toggle:hover { color: var(--coral); }
  .readlater-toggle.syncing { opacity: 0.55; }
  .archive-act { color: var(--archive); }
  .archive-act:hover { color: var(--coral); }
  .post-error {
    margin: 4px 0 0 38px;
    color: #a33;
    font-size: 11px;
  }
</style>
