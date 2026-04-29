<script lang="ts">
  import { canSign, currentSession, session as sessionStore } from '$lib/stores/session';
  import { api, ApiError } from '$lib/api/client';
  import { buildBookmarkEvent } from '$lib/nostr/bookmarks';
  import { publishEvent } from '$lib/nostr/publish';
  import { addToPrivateSet, updatePrivateSetEntry } from '$lib/nostr/private-bookmarks';
  import { getLifetimeStatus } from '$lib/nostr/lifetime-status';
  import { userSettings } from '$lib/stores/user-settings';
  import { config } from '$lib/config';
  import { createEventDispatcher, onDestroy } from 'svelte';
  import ArchiveDialog from './ArchiveDialog.svelte';
  import TagChipInput from './TagChipInput.svelte';

  const dispatch = createEventDispatcher<{ saved: { url: string; isPublic: boolean; eventId: string } }>();

  let url = '';
  let title = '';
  let description = '';
  let tags: string[] = [];
  let suggestedTags: string[] = [];
  let isPublic = false;
  let archiveForever = $userSettings.archiveAllByDefault;
  let saving = false;
  let error = '';
  let success = '';
  let archiveDialogOpen = false;
  let archiveUrl = '';
  let archiveTier: 'private' | 'public' = 'private';
  let lastFetchedUrl = '';
  /** Warning text (retag failures, partial archive tagging) — rendered
   *  distinctly from the green success banner so the user doesn't read
   *  "couldn't tag the bookmark" as part of a success message. */
  let warning = '';
  /** Snapshot of the just-published bookmark so we can retag it with
   *  blossom + archive-tier once the ArchiveDialog completes. Public
   *  bookmarks get a replacement kind:39701; private bookmarks get the
   *  matching entry inside the encrypted NIP-51 set replaced in place. */
  let pendingArchive: {
    url: string;
    title?: string;
    description?: string;
    tags: string[];
    lightning?: string;
    isPublic: boolean;
  } | null = null;

  $: lifetimeStatus = $sessionStore.pubkey ? getLifetimeStatus($sessionStore.pubkey) : null;
  $: isLifetime = !!(lifetimeStatus && $lifetimeStatus);

  async function fetchMetadata() {
    const trimmed = url.trim();
    if (!trimmed) return;
    if (trimmed === lastFetchedUrl) return;
    // Cheap client-side sanity: only fire when the URL parses as http(s).
    // Avoids a round-trip (and a 400) while the user is still typing a
    // prefix like "https://examp" that's clearly not a full URL.
    try {
      const u = new URL(trimmed);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      if (!u.hostname.includes('.')) return;
    } catch { return; }
    lastFetchedUrl = trimmed;
    try {
      const meta = await api.metadata(trimmed);
      if (meta.title && !title) title = meta.title;
      if (meta.description && !description) description = meta.description;
      if (meta.suggestedTags?.length) suggestedTags = meta.suggestedTags;
    } catch (e) {
      // Non-blocking — user can still type the metadata themselves.
      if (!(e instanceof ApiError)) error = (e as Error).message;
    }
  }

  /** Debounce the URL-input handler so we don't fire on every keystroke,
   *  but do fire as soon as the user pauses or pastes — no blur required. */
  let fetchDebounce: ReturnType<typeof setTimeout> | null = null;
  function scheduleFetch() {
    if (fetchDebounce) clearTimeout(fetchDebounce);
    fetchDebounce = setTimeout(fetchMetadata, 400);
  }
  onDestroy(() => { if (fetchDebounce) clearTimeout(fetchDebounce); });

  async function save() {
    if (!url.trim()) return;
    if (!$canSign) {
      error = 'Connect a signer to save bookmarks.';
      return;
    }
    error = '';
    success = '';
    warning = '';
    saving = true;
    try {
      const tagList = tags;
      const sessionState = currentSession();
      const pubkey = sessionState.pubkey!;

      let eventId = '';

      if (isPublic) {
        const template = buildBookmarkEvent({
          url: url.trim(),
          title: title.trim() || undefined,
          description: description.trim() || undefined,
          tags: tagList
        });
        const result = await publishEvent(template, pubkey);
        eventId = result.eventId;
        success = `published to ${result.relays.length} relay${result.relays.length === 1 ? '' : 's'}`;
      } else {
        const { template } = await addToPrivateSet(
          {
            url: url.trim(),
            title: title.trim() || undefined,
            description: description.trim() || undefined,
            tags: tagList
          },
          pubkey
        );
        const result = await publishEvent(template, pubkey);
        eventId = result.eventId;
        success = 'saved privately (encrypted)';
      }

      if (archiveForever) {
        // Hand off to ArchiveDialog so the user can confirm tier + watch
        // payment + polling progress without blocking the save flow.
        archiveUrl = url.trim();
        archiveTier = isPublic ? 'public' : 'private';
        archiveDialogOpen = true;
        // Capture enough to retag the bookmark (public kind:39701 or
        // private kind:30003 set entry) with blossom + archive-tier tags
        // once the archive dialog fires `done` — the form clears below.
        pendingArchive = {
          url: url.trim(),
          title: title.trim() || undefined,
          description: description.trim() || undefined,
          tags: [...tagList],
          isPublic,
        };
      }

      dispatch('saved', { url: url.trim(), isPublic, eventId });
      url = title = description = '';
      tags = [];
      suggestedTags = [];
      lastFetchedUrl = '';
      isPublic = false;
      archiveForever = $userSettings.archiveAllByDefault;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      saving = false;
    }
  }

  /** Retag the just-archived bookmark with blossom hash + archive-tier
   *  so feed rows render the archive link and the user's "archived
   *  forever" counter increments. Public bookmarks: replace the kind:39701
   *  (replaceable by the url d-tag). Private bookmarks: update the
   *  matching entry inside the encrypted NIP-51 set. Runs even when
   *  blossomHash is empty (wayback-only archive) — the tier tag itself
   *  is enough to drive the UI state. */
  async function onArchiveDone(
    detail: { hash: string; wayback?: string },
  ): Promise<void> {
    success += ' · archive complete';
    const snap = pendingArchive;
    pendingArchive = null;
    if (!snap) return;
    try {
      const sessionState = currentSession();
      const pubkey = sessionState.pubkey;
      if (!pubkey) return;
      const inputForTags = {
        url: snap.url,
        title: snap.title,
        description: snap.description,
        tags: snap.tags,
        lightning: snap.lightning,
        blossomHash: detail.hash || undefined,
        waybackUrl: detail.wayback,
        archivedForever: true,
      };
      if (snap.isPublic) {
        await publishEvent(buildBookmarkEvent(inputForTags), pubkey);
      } else {
        const { template } = await updatePrivateSetEntry(inputForTags, pubkey);
        await publishEvent(template, pubkey);
      }
    } catch (e) {
      // Archive succeeded; only the follow-up retag failed. Surface as
      // a warning (not blended into success) so the user knows they can
      // re-save to pick up the tags manually.
      warning = `archive saved but couldn't tag the bookmark: ${(e as Error).message}`;
    }
  }
</script>

<div class="save-box" class:disabled={!$canSign}>
  <strong>＋ bookmark a page</strong>
  &nbsp;&nbsp;or paste url:
  <input
    type="text"
    placeholder="https://…"
    bind:value={url}
    on:input={scheduleFetch}
    on:blur={fetchMetadata}
    disabled={saving}
  />
  <button class="pixel-press" on:click={save} disabled={saving || !url.trim()}>
    {saving ? 'saving…' : 'save'}
  </button>
  {#if title || description || tags.length > 0 || url}
    <div class="extra">
      <input type="text" placeholder="title (optional — auto-filled)" bind:value={title} />
      <input type="text" placeholder="description (optional)" bind:value={description} />
      <TagChipInput bind:tags suggestions={suggestedTags} placeholder="tags (space or comma to add)" />
    </div>
  {/if}
  <div class="save-options">
    <label><input type="radio" name="visibility" checked={!isPublic} on:change={() => (isPublic = false)} /> 🔒 private (default — only you)</label>
    <label><input type="radio" name="visibility" checked={isPublic} on:change={() => (isPublic = true)} /> share publicly on the network</label>
    <label><input type="checkbox" bind:checked={archiveForever} /> archive forever{isLifetime ? '' : ` (+${config.archivePriceSats} sats)`}</label>
  </div>
  {#if error}<div class="error">{error}</div>{/if}
  {#if success}<div class="success">{success}</div>{/if}
  {#if warning}<div class="warning">{warning}</div>{/if}
  {#if !$canSign}
    <div class="overlay">
      <span>🔒 Connect your signer to save bookmarks</span>
    </div>
  {/if}
</div>

<ArchiveDialog
  url={archiveUrl}
  tier={archiveTier}
  bind:open={archiveDialogOpen}
  on:close={() => { archiveDialogOpen = false; pendingArchive = null; }}
  on:done={(e) => onArchiveDone(e.detail)}
/>

<style>
  .save-box {
    background: var(--save-tint);
    border: 1px solid var(--coral-soft);
    border-radius: 8px;
    padding: 14px 16px;
    margin-bottom: 22px;
    font-size: 12px;
    box-shadow: 0 1px 0 rgba(255, 107, 90, 0.08);
    position: relative;
  }
  .save-box strong {
    color: var(--coral-deep);
    font-weight: 600;
  }
  .save-box input[type='text'] {
    padding: 5px 8px;
    font-family: inherit;
    font-size: 12px;
    border: 1px solid var(--rule);
    border-radius: 4px;
    background: var(--surface);
    color: var(--ink);
    width: 280px;
  }
  .save-box input[type='text']:focus {
    outline: 2px solid var(--coral-soft);
    border-color: var(--coral);
  }
  .save-box .extra {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 10px;
  }
  .save-box .extra input {
    width: 100% !important;
  }
  .save-box button {
    font-family: inherit;
    font-size: 12px;
    padding: 5px 14px;
    border: none;
    background: var(--coral);
    color: var(--on-coral);
    cursor: pointer;
    border-radius: 4px;
    font-weight: 500;
  }
  .save-box button:hover:not(:disabled) {
    background: var(--coral-deep);
  }
  .save-box button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .save-box label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--muted);
    cursor: pointer;
  }
  .save-box .save-options {
    display: flex;
    gap: 16px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px dashed var(--rule);
    font-size: 11px;
    flex-wrap: wrap;
  }
  .error {
    margin-top: 8px;
    color: var(--coral-deep);
    font-size: 12px;
  }
  .success {
    margin-top: 8px;
    color: var(--archive);
    font-size: 12px;
  }
  .warning {
    margin-top: 8px;
    color: #a33;
    background: rgba(196, 68, 68, 0.08);
    border-left: 3px solid #c44;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 12px;
  }
  .save-box.disabled > *:not(.overlay) {
    opacity: 0.4;
    pointer-events: none;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--save-tint);
    opacity: 0.92;
    border-radius: 10px;
    color: var(--ink-deep);
    font-weight: 500;
    font-size: 14px;
    cursor: pointer;
  }
  @media (max-width: 720px) {
    .save-box input[type='text'] {
      width: 100%;
      margin: 6px 0;
    }
  }
</style>
