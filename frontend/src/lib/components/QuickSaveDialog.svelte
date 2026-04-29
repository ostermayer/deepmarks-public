<script lang="ts">
  // Pre-filled save dialog — a lighter cousin of SaveBox used when the user
  // clicks "save" on a bookmark they're viewing in the feed. The URL comes
  // in locked; title/description/tags are editable; they pick private vs
  // public and optionally archive forever.
  //
  // Behaviour mirrors SaveBox (publishes kind:39701 public OR adds to
  // kind:30003 private set). Archive purchase hand-off uses the existing
  // ArchiveDialog component.

  import { createEventDispatcher } from 'svelte';
  import { canSign, currentSession, session as sessionStore } from '$lib/stores/session';
  import { api, ApiError } from '$lib/api/client';
  import { buildBookmarkEvent } from '$lib/nostr/bookmarks';
  import { publishEvent } from '$lib/nostr/publish';
  import { addToPrivateSet, updatePrivateSetEntry } from '$lib/nostr/private-bookmarks';
  import { getLifetimeStatus } from '$lib/nostr/lifetime-status';
  import { userSettings } from '$lib/stores/user-settings';
  import { config } from '$lib/config';
  import ArchiveDialog from './ArchiveDialog.svelte';
  import TagChipInput from './TagChipInput.svelte';

  export let open = false;
  export let url: string;
  export let initialTitle: string = '';
  export let initialDescription: string = '';
  export let initialTags: string[] = [];

  const dispatch = createEventDispatcher<{ close: void; saved: { eventId: string } }>();

  let title = '';
  let description = '';
  let tags: string[] = [];
  let suggestedTags: string[] = [];
  let isPublic = false;
  let archiveForever = false;
  let saving = false;
  let error = '';
  let archiveDialogOpen = false;
  let metaFetched = false;
  /** Snapshot of the just-published bookmark so we can retag with
   *  blossom + archive-tier after ArchiveDialog finishes. Public uses
   *  a replacement kind:39701; private rewrites the matching entry in
   *  the encrypted NIP-51 set. */
  let pendingArchive: {
    url: string;
    title?: string;
    description?: string;
    tags: string[];
    isPublic: boolean;
  } | null = null;

  $: lifetimeStatus = $sessionStore.pubkey ? getLifetimeStatus($sessionStore.pubkey) : null;
  $: isLifetime = !!(lifetimeStatus && $lifetimeStatus);

  // Re-prime the form each time the dialog opens for a new URL. The
  // archive checkbox defaults from the user's "archive all bookmarks by
  // default" setting; lifetime members won't see a price next to it.
  $: if (open) {
    title = initialTitle;
    description = initialDescription;
    tags = [...initialTags];
    suggestedTags = [];
    isPublic = false;
    archiveForever = $userSettings.archiveAllByDefault;
    error = '';
    metaFetched = false;
    void fetchMetadata();
  }

  async function fetchMetadata() {
    if (metaFetched || !url) return;
    metaFetched = true;
    try {
      const meta = await api.metadata(url);
      if (meta.title && !title) title = meta.title;
      if (meta.description && !description) description = meta.description;
      if (meta.suggestedTags?.length) suggestedTags = meta.suggestedTags;
    } catch (e) {
      if (!(e instanceof ApiError)) {
        // Swallow — the user can still type metadata themselves.
      }
    }
  }

  function close() {
    dispatch('close');
  }

  async function save() {
    if (!$canSign) {
      error = 'Connect a signer to save bookmarks.';
      return;
    }
    error = '';
    saving = true;
    try {
      const tagList = tags;
      const sessionState = currentSession();
      const pubkey = sessionState.pubkey!;
      let eventId = '';

      if (isPublic) {
        const template = buildBookmarkEvent({
          url,
          title: title.trim() || undefined,
          description: description.trim() || undefined,
          tags: tagList,
        });
        const result = await publishEvent(template, pubkey);
        eventId = result.eventId;
      } else {
        const { template } = await addToPrivateSet(
          {
            url,
            title: title.trim() || undefined,
            description: description.trim() || undefined,
            tags: tagList,
          },
          pubkey,
        );
        const result = await publishEvent(template, pubkey);
        eventId = result.eventId;
      }

      if (archiveForever) {
        pendingArchive = {
          url,
          title: title.trim() || undefined,
          description: description.trim() || undefined,
          tags: [...tagList],
          isPublic,
        };
        archiveDialogOpen = true;
      } else {
        dispatch('saved', { eventId });
        close();
      }
    } catch (e) {
      error = (e as Error).message;
    } finally {
      saving = false;
    }
  }

  async function onArchiveDone(detail: { hash: string; wayback?: string }): Promise<void> {
    archiveDialogOpen = false;
    const snap = pendingArchive;
    pendingArchive = null;
    if (snap) {
      try {
        const sessionState = currentSession();
        const pubkey = sessionState.pubkey;
        if (pubkey) {
          const input = {
            url: snap.url,
            title: snap.title,
            description: snap.description,
            tags: snap.tags,
            blossomHash: detail.hash || undefined,
            waybackUrl: detail.wayback,
            archivedForever: true,
          };
          if (snap.isPublic) {
            await publishEvent(buildBookmarkEvent(input), pubkey);
          } else {
            const { template } = await updatePrivateSetEntry(input, pubkey);
            await publishEvent(template, pubkey);
          }
        }
      } catch {
        // Archive already succeeded — swallow the tag-update failure.
      }
    }
    dispatch('saved', { eventId: '' });
    close();
  }
</script>

{#if open}
  <div
    class="backdrop"
    on:click={close}
    on:keydown={(e) => e.key === 'Escape' && close()}
    role="presentation"
  >
    <div
      class="dialog"
      on:click|stopPropagation
      on:keydown|stopPropagation
      role="dialog"
      aria-modal="true"
      aria-labelledby="quicksave-title"
      tabindex="-1"
    >
      <h3 id="quicksave-title">save to your bookmarks</h3>
      <p class="url">{url}</p>

      {#if !$canSign}
        <div class="hint">
          <a href="/login">sign in with a signer</a> to save bookmarks to your own account.
        </div>
      {:else}
        <label class="field">
          <span>title</span>
          <input type="text" bind:value={title} placeholder="(auto-detected)" />
        </label>

        <label class="field">
          <span>description</span>
          <textarea rows="2" bind:value={description} placeholder="your note about this link"></textarea>
        </label>

        <div class="field">
          <span>tags</span>
          <TagChipInput bind:tags suggestions={suggestedTags} placeholder="tags (space or comma to add)" />
        </div>

        <fieldset class="visibility">
          <label>
            <input type="radio" name="qs-vis" checked={!isPublic} on:change={() => (isPublic = false)} />
            🔒 private (only you)
          </label>
          <label>
            <input type="radio" name="qs-vis" checked={isPublic} on:change={() => (isPublic = true)} />
            share publicly on the network
          </label>
        </fieldset>

        <label class="archive-row">
          <input type="checkbox" bind:checked={archiveForever} />
          archive forever{isLifetime ? '' : ` (+${config.archivePriceSats} sats)`}
        </label>

        {#if error}<div class="error">{error}</div>{/if}

        <div class="actions">
          <button type="button" class="ghost" on:click={close} disabled={saving}>cancel</button>
          <button
            type="button"
            class="primary pixel-press"
            on:click={save}
            disabled={saving}
          >
            {saving ? 'saving…' : 'save'}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<ArchiveDialog
  {url}
  tier={isPublic ? 'public' : 'private'}
  bind:open={archiveDialogOpen}
  on:close={() => {
    archiveDialogOpen = false;
    pendingArchive = null;
    dispatch('saved', { eventId: '' });
    close();
  }}
  on:done={(e) => onArchiveDone(e.detail)}
/>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(13, 62, 92, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .dialog {
    background: var(--surface);
    border-radius: 12px;
    padding: 24px;
    width: min(460px, 92vw);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
  }
  h3 {
    margin: 0 0 4px;
    color: var(--ink-deep);
    font-size: 18px;
  }
  .url {
    color: var(--muted);
    font-family: 'Courier New', monospace;
    font-size: 11px;
    margin: 0 0 16px;
    word-break: break-all;
  }
  .hint {
    padding: 12px;
    border: 1px dashed var(--rule);
    border-radius: 8px;
    font-size: 13px;
    color: var(--muted);
    text-align: center;
  }
  .field {
    display: block;
    margin-bottom: 12px;
  }
  .field span {
    display: block;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--muted);
    margin-bottom: 4px;
    font-weight: 600;
  }
  .field input,
  .field textarea {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: var(--surface);
    color: var(--ink);
    font-family: inherit;
    font-size: 13px;
  }
  .field input:focus,
  .field textarea:focus {
    outline: 2px solid var(--coral-soft);
    border-color: var(--coral);
  }
  .visibility {
    border: 1px solid var(--rule);
    border-radius: 8px;
    padding: 10px 12px;
    margin: 0 0 12px;
  }
  .visibility label {
    display: block;
    padding: 4px 0;
    font-size: 13px;
    cursor: pointer;
  }
  .archive-row {
    display: block;
    padding: 8px 0;
    font-size: 13px;
    cursor: pointer;
  }
  .error {
    padding: 8px 12px;
    background: var(--coral-soft);
    color: var(--coral-deep);
    border-radius: 8px;
    font-size: 12px;
    margin-bottom: 12px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .primary {
    background: var(--coral);
    color: var(--on-coral);
    border: 0;
    padding: 8px 18px;
    border-radius: 100px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
  }
  .primary:hover:not(:disabled) {
    background: var(--coral-deep);
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .ghost {
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 8px 16px;
    border-radius: 100px;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
  }
</style>
