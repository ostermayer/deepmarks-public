<script lang="ts">
  // Inline bookmark editor — replaces the BookmarkEditDialog modal.
  // Renders title / description / tags inputs, visibility toggle, an
  // archive-forever checkbox, and save/delete/cancel actions. Caller
  // mounts this inside the row body when the user clicks "edit"; no
  // overlay, no backdrop.
  //
  // Same primitives as the old dialog: kind:39701 republish for public,
  // updatePrivateSetEntry for private, kind:5 deletion for public,
  // removeFromPrivateSet for private. Visibility swap and retro-archive
  // also kept — the archive flow still opens its own focused dialog
  // because it's a payment surface (invoice + WebLN/NWC) that wants a
  // dedicated context.

  import { createEventDispatcher } from 'svelte';
  import { canSign, currentSession, session as sessionStore } from '$lib/stores/session';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { buildBookmarkEvent } from '$lib/nostr/bookmarks';
  import { publishEvent } from '$lib/nostr/publish';
  import { publishBookmarkDeletion } from '$lib/nostr/delete';
  import {
    removeFromPrivateSet,
    updatePrivateSetEntry,
  } from '$lib/nostr/private-bookmarks';
  import { getLifetimeStatus } from '$lib/nostr/lifetime-status';
  import { config } from '$lib/config';
  import TagChipInput from './TagChipInput.svelte';
  import ArchiveDialog from './ArchiveDialog.svelte';

  export let bookmark: ParsedBookmark;
  /** True when this bookmark lives in the caller's encrypted NIP-51 set. */
  export let isPrivate: boolean = false;

  const dispatch = createEventDispatcher<{
    cancel: void;
    updated: { eventId: string };
    deleted: { eventId: string };
  }>();

  let title = bookmark.title === bookmark.url ? '' : bookmark.title;
  let description = bookmark.description ?? '';
  let tags: string[] = [...bookmark.tags];
  let wantsArchive = false;
  let working = false;
  let deleting = false;
  let swapping = false;
  let error = '';
  let archiveDialogOpen = false;
  let pendingArchive:
    | { url: string; title?: string; description?: string; tags: string[]; isPrivate: boolean }
    | null = null;

  // Two-stage confirm states for delete + public→private swap.
  let deleteArmed = false;
  let deleteArmTimer: ReturnType<typeof setTimeout> | null = null;
  let privacySwapArmed = false;
  let privacySwapTimer: ReturnType<typeof setTimeout> | null = null;

  $: lifetimeStatus = $sessionStore.pubkey ? getLifetimeStatus($sessionStore.pubkey) : null;
  $: isLifetime = !!(lifetimeStatus && $lifetimeStatus);
  $: alreadyArchived = bookmark.archivedForever;

  function cancel() {
    if (working || deleting || swapping) return;
    if (deleteArmTimer) { clearTimeout(deleteArmTimer); deleteArmTimer = null; }
    if (privacySwapTimer) { clearTimeout(privacySwapTimer); privacySwapTimer = null; }
    dispatch('cancel');
  }

  function onSwapClick() {
    if (!$canSign) {
      error = 'connect your signer to change visibility';
      return;
    }
    if (isPrivate) {
      void swapVisibility();  // private → public is leak-free, commit immediately
      return;
    }
    if (!privacySwapArmed) {
      privacySwapArmed = true;
      if (privacySwapTimer) clearTimeout(privacySwapTimer);
      privacySwapTimer = setTimeout(() => { privacySwapArmed = false; }, 5_000);
      return;
    }
    void swapVisibility();
  }

  async function swapVisibility() {
    if (privacySwapTimer) { clearTimeout(privacySwapTimer); privacySwapTimer = null; }
    privacySwapArmed = false;
    error = '';
    swapping = true;
    try {
      const sessionState = currentSession();
      const pubkey = sessionState.pubkey;
      if (!pubkey) throw new Error('not signed in');
      if (pubkey !== bookmark.curator) throw new Error('you can only change visibility on your own bookmarks');

      const input = {
        url: bookmark.url,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        tags,
        lightning: bookmark.lightning,
        blossomHash: alreadyArchived ? bookmark.blossomHash : undefined,
        waybackUrl: alreadyArchived ? bookmark.waybackUrl : undefined,
        archivedForever: alreadyArchived,
      };

      if (isPrivate) {
        // Private → public: publish kind:39701 first so a failed
        // remove-from-private doesn't orphan the bookmark.
        const result = await publishEvent(buildBookmarkEvent(input), pubkey);
        const { template } = await removeFromPrivateSet(bookmark.url, pubkey);
        await publishEvent(template, pubkey);
        dispatch('updated', { eventId: result.eventId });
      } else {
        // Public → private: write into the private set first, THEN
        // publish kind:5. If the deletion fails, the bookmark still
        // lives in the private set; the public copy can be re-deleted later.
        const { template } = await updatePrivateSetEntry(input, pubkey);
        const result = await publishEvent(template, pubkey);
        await publishBookmarkDeletion({
          pubkey,
          eventId: bookmark.eventId,
          url: bookmark.url,
          reason: 'made private',
        });
        dispatch('updated', { eventId: result.eventId });
      }
    } catch (e) {
      error = (e as Error).message ?? 'visibility change failed';
    } finally {
      swapping = false;
    }
  }

  async function save() {
    if (!$canSign) {
      error = 'connect your signer to edit';
      return;
    }
    error = '';
    working = true;
    try {
      const sessionState = currentSession();
      const pubkey = sessionState.pubkey;
      if (!pubkey) throw new Error('not signed in');
      if (pubkey !== bookmark.curator) throw new Error('you can only edit your own bookmarks');

      const bookmarkInput = {
        url: bookmark.url,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        tags,
        lightning: bookmark.lightning,
        blossomHash: alreadyArchived ? bookmark.blossomHash : undefined,
        waybackUrl: alreadyArchived ? bookmark.waybackUrl : undefined,
        archivedForever: alreadyArchived,
      };

      let eventId = '';
      if (isPrivate) {
        const { template } = await updatePrivateSetEntry(bookmarkInput, pubkey);
        const result = await publishEvent(template, pubkey);
        eventId = result.eventId;
      } else {
        const template = buildBookmarkEvent(bookmarkInput);
        const result = await publishEvent(template, pubkey);
        eventId = result.eventId;
      }

      if (!alreadyArchived && wantsArchive) {
        // Capture form state so the post-archive retag writes back to
        // the right primitive with the new blossom tags.
        pendingArchive = {
          url: bookmark.url,
          title: title.trim() || undefined,
          description: description.trim() || undefined,
          tags: [...tags],
          isPrivate,
        };
        archiveDialogOpen = true;
        dispatch('updated', { eventId });
      } else {
        dispatch('updated', { eventId });
        cancel();
      }
    } catch (e) {
      error = (e as Error).message ?? 'publish failed';
    } finally {
      working = false;
    }
  }

  function onDeleteClick() {
    if (!$canSign) { error = 'connect your signer to delete'; return; }
    if (!deleteArmed) {
      deleteArmed = true;
      if (deleteArmTimer) clearTimeout(deleteArmTimer);
      deleteArmTimer = setTimeout(() => { deleteArmed = false; }, 5_000);
      return;
    }
    void performDelete();
  }

  async function performDelete() {
    if (deleteArmTimer) { clearTimeout(deleteArmTimer); deleteArmTimer = null; }
    deleting = true;
    error = '';
    try {
      const sessionState = currentSession();
      const pubkey = sessionState.pubkey;
      if (!pubkey) throw new Error('not signed in');
      if (pubkey !== bookmark.curator) throw new Error('you can only delete your own bookmarks');

      if (isPrivate) {
        const { template } = await removeFromPrivateSet(bookmark.url, pubkey);
        const result = await publishEvent(template, pubkey);
        dispatch('deleted', { eventId: result.eventId });
      } else {
        const res = await publishBookmarkDeletion({
          pubkey,
          eventId: bookmark.eventId,
          url: bookmark.url,
          reason: 'user-requested',
        });
        dispatch('deleted', { eventId: res.deletionEventId });
      }
    } catch (e) {
      error = (e as Error).message ?? 'deletion failed';
    } finally {
      deleting = false;
      deleteArmed = false;
    }
  }

  async function onArchiveDone(detail: { hash: string; wayback?: string }) {
    archiveDialogOpen = false;
    const snap = pendingArchive;
    pendingArchive = null;
    if (!snap) { cancel(); return; }
    try {
      const sessionState = currentSession();
      const pubkey = sessionState.pubkey;
      if (!pubkey) return;
      const input = {
        url: snap.url,
        title: snap.title,
        description: snap.description,
        tags: snap.tags,
        lightning: bookmark.lightning,
        blossomHash: detail.hash || undefined,
        waybackUrl: detail.wayback,
        archivedForever: true,
      };
      if (snap.isPrivate) {
        const { template } = await updatePrivateSetEntry(input, pubkey);
        await publishEvent(template, pubkey);
      } else {
        await publishEvent(buildBookmarkEvent(input), pubkey);
      }
    } catch {
      // Archive succeeded; swallow the retag failure.
    } finally {
      cancel();
    }
  }
</script>

<div class="edit-form">
  <p class="locked-url" title="URL is fixed — public bookmarks key on the d-tag">{bookmark.url}</p>

  <label class="field">
    <span>title</span>
    <input
      type="text"
      bind:value={title}
      placeholder="(leave blank to fall back to the URL)"
      disabled={working || deleting || swapping}
    />
  </label>

  <label class="field">
    <span>description</span>
    <textarea
      rows="2"
      bind:value={description}
      placeholder="your note about this link"
      disabled={working || deleting || swapping}
    ></textarea>
  </label>

  <div class="field">
    <span>tags</span>
    <TagChipInput bind:tags placeholder="tags (space or comma to add)" />
  </div>

  {#if alreadyArchived}
    <p class="archive-state">📦 this bookmark is archived forever.</p>
  {:else}
    <label class="archive-row">
      <input
        type="checkbox"
        bind:checked={wantsArchive}
        disabled={working || deleting || swapping}
      />
      archive forever now{isLifetime ? '' : ` (+${config.archivePriceSats} sats)`}
    </label>
  {/if}

  <div class="visibility-row">
    <span class="visibility-tag">{isPrivate ? '🔒 private' : '🌍 public'}</span>
    <button
      type="button"
      class="ghost ghost-small"
      class:armed={privacySwapArmed}
      on:click={onSwapClick}
      disabled={working || deleting || swapping}
    >
      {#if swapping}working…
      {:else if privacySwapArmed}confirm make private
      {:else if isPrivate}make public
      {:else}make private{/if}
    </button>
  </div>
  {#if privacySwapArmed}
    <p class="caveat">
      we'll ask nostr relays to drop the public copy. our relay and well-behaved
      relays honor that; others may keep cached copies.
      <span class="caveat-hint">click again to confirm</span>
    </p>
  {/if}

  {#if error}<div class="error">{error}</div>{/if}

  {#if deleteArmed && !deleting}
    <p class="caveat">
      {#if isPrivate}
        remove from your private bookmarks? this can't be undone from our side.
      {:else}
        well-behaved relays will drop this public bookmark; copies already fetched
        by other relays or clients may linger.
      {/if}
      <span class="caveat-hint">click delete again to confirm</span>
    </p>
  {/if}

  <div class="actions">
    <button
      type="button"
      class="destroy"
      class:armed={deleteArmed}
      on:click={onDeleteClick}
      disabled={working || swapping}
    >
      {#if deleting}deleting…
      {:else if deleteArmed}confirm delete
      {:else}delete{/if}
    </button>
    <div class="right-actions">
      <button type="button" class="ghost" on:click={cancel} disabled={working || deleting || swapping}>cancel</button>
      <button
        type="button"
        class="primary"
        on:click={() => void save()}
        disabled={working || deleting || swapping}
      >
        {working ? 'saving…' : 'save'}
      </button>
    </div>
  </div>
</div>

<ArchiveDialog
  url={bookmark.url}
  tier={isPrivate ? 'private' : 'public'}
  bind:open={archiveDialogOpen}
  on:close={() => { archiveDialogOpen = false; pendingArchive = null; cancel(); }}
  on:done={(e) => onArchiveDone(e.detail)}
/>

<style>
  .edit-form {
    margin-top: 8px;
    padding: 12px 14px;
    background: var(--paper-warm);
    border: 1px solid var(--rule);
    border-radius: 8px;
    font-size: 13px;
  }
  .locked-url {
    color: var(--muted);
    font-family: 'Courier New', monospace;
    font-size: 11px;
    margin: 0 0 12px;
    word-break: break-all;
  }
  .field { display: block; margin-bottom: 12px; }
  .field span {
    display: block;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--ink);
    margin-bottom: 4px;
    font-weight: 600;
  }
  .field input, .field textarea {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: var(--surface);
    color: var(--ink-deep);
    font-family: inherit;
    font-size: 13px;
    box-sizing: border-box;
  }
  .field textarea { resize: vertical; min-height: 56px; }
  .field input:focus, .field textarea:focus {
    outline: 2px solid var(--coral-soft);
    border-color: var(--coral);
  }
  .archive-row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 0;
    cursor: pointer;
    color: var(--ink-deep);
  }
  .archive-state { color: var(--archive); padding: 6px 0; margin: 0; }
  .visibility-row {
    display: flex; align-items: center; gap: 10px;
    padding: 6px 0 10px;
    color: var(--ink-deep);
  }
  .visibility-tag { font-weight: 500; }
  .error {
    padding: 8px 12px;
    background: var(--coral-soft);
    color: var(--coral-deep);
    border-radius: 6px;
    font-size: 12px;
    margin-bottom: 12px;
  }
  .caveat {
    margin: 8px 0 0;
    padding: 8px 10px;
    background: rgba(196, 68, 68, 0.08);
    border-left: 3px solid #c44;
    border-radius: 4px;
    color: var(--ink-deep);
    font-size: 12px;
    line-height: 1.5;
  }
  .caveat-hint { display: block; font-style: italic; color: #a33; margin-top: 4px; }
  .actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }
  .right-actions { display: flex; gap: 8px; }
  .primary {
    background: var(--coral);
    color: var(--on-coral);
    border: 0;
    padding: 7px 16px;
    border-radius: 100px;
    font-weight: 500;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .primary:hover:not(:disabled) { background: var(--coral-deep); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .ghost {
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--ink-deep);
    padding: 7px 14px;
    border-radius: 100px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .ghost-small { padding: 5px 12px; font-size: 11px; }
  .ghost:hover:not(:disabled) { border-color: var(--coral); color: var(--coral-deep); }
  .ghost.armed, .ghost-small.armed { border-color: #c44; color: #a33; }
  .destroy {
    background: transparent;
    border: 1px solid #c44;
    color: #a33;
    padding: 7px 14px;
    border-radius: 100px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .destroy:hover:not(:disabled) { background: #c44; color: #fff; }
  .destroy:disabled { opacity: 0.4; cursor: not-allowed; }
  .destroy.armed { background: #c44; color: #fff; }
</style>
