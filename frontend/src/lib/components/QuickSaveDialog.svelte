<script lang="ts">
  // Pre-filled save dialog — a lighter cousin of SaveBox used when the user
  // clicks "save" on a bookmark they're viewing in the feed. The URL comes
  // in locked; title/description/tags are editable; they pick private vs
  // public and optionally archive forever.
  //
  // Behaviour mirrors SaveBox (publishes kind:39701 public OR adds to
  // kind:30003 private set). Lifetime archive-default saves enqueue an
  // archive immediately after the bookmark is saved.

  import { createEventDispatcher } from 'svelte';
  import { canSign, currentSession, session as sessionStore, sessionRestoring } from '$lib/stores/session';
  import { api, ApiError } from '$lib/api/client';
  import { isNativeShell } from '$lib/native/runtime';
  import { defaultSocialPostText } from '$lib/nostr/social-post';
  import { saveBookmark } from '$lib/nostr/save-bookmark';
  import { getLifetimeStatus } from '$lib/nostr/lifetime-status';
  import { isDeepmarksExtensionAvailable } from '$lib/nostr/signers';
  import { enqueueArchivePage } from '$lib/nostr/archive';
  import { mergeBookmarkTagsWithDefaults, userSettings } from '$lib/stores/user-settings';
  import { IS_APPLE_BUILD } from '$lib/build-flags';
  import TagChipInput from './TagChipInput.svelte';
  import MentionTextarea from './MentionTextarea.svelte';

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
  let crossPostToNostr = false;
  let socialPostText = '';
  let socialPostEdited = false;
  let archiveForever = false;
  let archiveTouched = false;
  let saving = false;
  let error = '';
  let metaFetched = false;

  $: lifetimeStatus = $sessionStore.pubkey ? getLifetimeStatus($sessionStore.pubkey) : null;
  $: lifetimeStatusLoading = !!lifetimeStatus && $lifetimeStatus === null;
  $: isLifetime = !!(lifetimeStatus && $lifetimeStatus === true);
  $: canUseArchiveFlow = isLifetime;
  $: defaultArchiveForever = canUseArchiveFlow && (
    $userSettings.archiveAllByDefault || !$userSettings.archiveDefaultManualOverride
  );
  $: if (!canUseArchiveFlow && archiveForever) archiveForever = false;
  $: if (canUseArchiveFlow && !archiveTouched && archiveForever !== defaultArchiveForever) {
    archiveForever = defaultArchiveForever;
  }
  $: socialPostDefault = defaultSocialPostText({ url, title, description });
  $: if (isPublic && crossPostToNostr && !socialPostEdited) socialPostText = socialPostDefault;

  // Re-prime the form each time the dialog opens for a new URL. The
  // archive checkbox defaults from the user's "archive all bookmarks by
  // default" setting for lifetime members.
  $: if (open) {
    title = initialTitle;
    description = initialDescription;
    tags = mergeBookmarkTagsWithDefaults(initialTags, $userSettings.defaultTags);
    suggestedTags = [];
    isPublic = $userSettings.defaultVisibility === 'public';
    archiveTouched = false;
    archiveForever = defaultArchiveForever;
    crossPostToNostr = false;
    socialPostText = '';
    socialPostEdited = false;
    error = '';
    metaFetched = false;
    void fetchMetadata();
  }

  async function fetchMetadata() {
    if (metaFetched || !url) return;
    metaFetched = true;
    try {
      const meta = await api.metadata(url, { fast: isNativeShell() });
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

  function onCrossPostToggle(e: Event) {
    crossPostToNostr = (e.currentTarget as HTMLInputElement).checked;
    if (crossPostToNostr && !socialPostEdited) socialPostText = socialPostDefault;
  }

  function usesBrowserExtensionSession(): boolean {
    return sessionStore.hint?.kind === 'nip07' ||
      (typeof window !== 'undefined' && isDeepmarksExtensionAvailable());
  }

  function signerUnavailableMessage(action: string): string {
    if ($sessionRestoring) return 'Restoring your signer. Try again in a moment.';
    if (usesBrowserExtensionSession()) return `Unlock your browser extension to ${action}.`;
    return `Connect a signer to ${action}.`;
  }

  async function save() {
    if (!$canSign) {
      error = signerUnavailableMessage('save bookmarks');
      return;
    }
    error = '';
    saving = true;
    try {
      const tagList = tags;
      const sessionState = currentSession();
      const pubkey = sessionState.pubkey!;
      const { rememberOwnBookmarkWithRollback } = await import('$lib/stores/own-bookmarks');
      const result = await saveBookmark({
        url,
        title,
        description,
        tags: tagList,
        isPublic,
        pubkey,
        socialPostText: isPublic && crossPostToNostr ? socialPostText : undefined,
        // Optimistic update so the bookmark appears in the user's
        // list within a frame of clicking save (private-set publish
        // takes multiple seconds).
        onOptimistic: (b) => rememberOwnBookmarkWithRollback(b, isPublic),
      });
      if (result.socialWarning) {
        error = result.socialWarning;
      }

      if (archiveForever && canUseArchiveFlow) {
        try {
          await enqueueArchivePage({
            url,
            tier: isPublic ? 'public' : 'private',
            pubkey,
            eventId: isPublic ? result.eventId : undefined,
            bookmarkSavedAt: result.bookmark.savedAt,
            lifetime: true,
            mirrorUrls: $userSettings.backupBlossomServers,
            dedupe: true,
          });
        } catch (archiveError) {
          error = `bookmark saved but archive could not be queued: ${(archiveError as Error).message}`;
          dispatch('saved', { eventId: result.eventId });
          return;
        }
      }
      void import('$lib/media-archive').then(({ maybeQueueMediaArchiveForBookmark }) => (
        maybeQueueMediaArchiveForBookmark({
          bookmark: result.bookmark,
          url,
          pubkey,
          eventId: isPublic ? result.eventId : undefined,
          bookmarkSavedAt: result.bookmark.savedAt,
        })
      )).catch(() => { /* media add-on queue is best-effort after save */ });
      dispatch('saved', { eventId: result.eventId });
      close();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      saving = false;
    }
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
          {#if $sessionRestoring}
            restoring your signer…
          {:else if usesBrowserExtensionSession()}
            unlock your browser extension to save bookmarks to your own account.
          {:else}
            <a href="/login">sign in with a signer</a> to save bookmarks to your own account.
          {/if}
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

        {#if canUseArchiveFlow}
          <label class="archive-row">
            <input
              type="checkbox"
              bind:checked={archiveForever}
              on:change={() => { archiveTouched = true; }}
            />
            archive
          </label>
        {:else if lifetimeStatusLoading}
          <p class="archive-note">checking archive access...</p>
        {:else if !IS_APPLE_BUILD}
          <p class="archive-note"><a href="/app/upgrade">archive with lifetime</a></p>
        {/if}

        {#if isPublic}
          <div class="cross-post">
            <label>
              <input type="checkbox" checked={crossPostToNostr} on:change={onCrossPostToggle} />
              post a Nostr note too
            </label>
            {#if crossPostToNostr}
              <MentionTextarea
                rows={4}
                bind:value={socialPostText}
                on:input={() => (socialPostEdited = true)}
                placeholder="Nostr post text — type @ to mention a contact"
                disabled={saving}
              />
            {/if}
          </div>
        {/if}

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
  .archive-note {
    color: var(--muted);
    font-size: 12px;
    margin: 8px 0 12px;
  }
  .cross-post {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0 0 12px;
    color: var(--ink);
    font-size: 13px;
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
