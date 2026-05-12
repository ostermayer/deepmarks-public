<script lang="ts">
  import { canSign, currentSession, session as sessionStore, sessionRestoring } from '$lib/stores/session';
  import { api, ApiError } from '$lib/api/client';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { defaultSocialPostText } from '$lib/nostr/social-post';
  import { getLifetimeStatus } from '$lib/nostr/lifetime-status';
  import { isDeepmarksExtensionAvailable } from '$lib/nostr/signers';
  import { enqueueArchivePage } from '$lib/nostr/archive';
  import { userSettings } from '$lib/stores/user-settings';
  import { IS_APPLE_BUILD } from '$lib/build-flags';
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import TagChipInput from './TagChipInput.svelte';

  const dispatch = createEventDispatcher<{
    saved: { url: string; isPublic: boolean; eventId: string; bookmark: ParsedBookmark };
  }>();

  /** Optional URL to prefill — used by the /app/save route when the
   *  iOS / Android share-sheet hands us a URL via the deepmarks://
   *  scheme. When set, SaveBox skips its empty initial state and
   *  immediately runs the metadata fetch so the user sees title /
   *  description / tag suggestions on first paint. */
  export let prefillUrl: string = '';

  let url = prefillUrl;
  let title = '';
  let description = '';
  let tags: string[] = [];
  let suggestedTags: string[] = [];
  let isPublic = $userSettings.defaultVisibility === 'public';
  let crossPostToNostr = false;
  let socialPostText = '';
  let socialPostEdited = false;
  let archiveForever = false;
  let archiveTouched = false;
  let saving = false;
  let error = '';
  let success = '';
  let lastFetchedUrl = '';
  /** Warning text (retag failures, partial archive tagging) — rendered
   *  distinctly from the green success banner so the user doesn't read
   *  "couldn't tag the bookmark" as part of a success message. */
  let warning = '';
  let signerPrompt = '';

  $: lifetimeStatus = $sessionStore.pubkey ? getLifetimeStatus($sessionStore.pubkey) : null;
  $: isLifetime = !!(lifetimeStatus && $lifetimeStatus);
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
    if (url.trim() && tags.length === 0 && $userSettings.defaultTags.length > 0) {
      tags = [...$userSettings.defaultTags];
    }
    if (fetchDebounce) clearTimeout(fetchDebounce);
    fetchDebounce = setTimeout(fetchMetadata, 400);
  }
  onDestroy(() => { if (fetchDebounce) clearTimeout(fetchDebounce); });

  function onCrossPostToggle(e: Event) {
    crossPostToNostr = (e.currentTarget as HTMLInputElement).checked;
    if (crossPostToNostr && !socialPostEdited) socialPostText = socialPostDefault;
  }

  // Share-sheet prefill: when prefillUrl arrives we already have the
  // URL but no metadata. Fire the fetch immediately (no debounce) so
  // the form looks populated on first paint.
  onMount(() => {
    if (prefillUrl.trim()) {
      if (tags.length === 0) tags = [...$userSettings.defaultTags];
      void fetchMetadata();
    }
  });

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
    if (!url.trim()) return;
    if (!$canSign) {
      error = signerUnavailableMessage('save bookmarks');
      return;
    }
    error = '';
    success = '';
    warning = '';
    signerPrompt = '';
    saving = true;
    try {
      const tagList = tags;
      const sessionState = currentSession();
      const pubkey = sessionState.pubkey!;
      signerPrompt = sessionState.signer?.kind === 'nip07'
        ? 'Deepmarks is asking your browser extension to sign or encrypt this save. Approve it if prompted.'
        : '';

      const { saveBookmark } = await import('$lib/nostr/save-bookmark');
      const result = await saveBookmark({
        url: url.trim(),
        title,
        description,
        tags: tagList,
        isPublic,
        pubkey,
        socialPostText: isPublic && crossPostToNostr ? socialPostText : undefined,
      });
      const eventId = result.eventId;
      const savedBookmark: ParsedBookmark = result.bookmark;

      if (isPublic) {
        success = `published to ${result.publishRelayCount} relay${result.publishRelayCount === 1 ? '' : 's'}`;
        if (result.socialRelayCount > 0) {
          success += ` · posted note to ${result.socialRelayCount} relay${result.socialRelayCount === 1 ? '' : 's'}`;
        }
        if (result.socialWarning) warning = result.socialWarning;
      } else {
        success = 'saved privately (encrypted)';
      }

      if (archiveForever && canUseArchiveFlow) {
        try {
          await enqueueArchivePage({
            url: url.trim(),
            tier: isPublic ? 'public' : 'private',
            pubkey,
            eventId: isPublic ? eventId : undefined,
            lifetime: true,
            mirrorUrls: $userSettings.backupBlossomServers,
            dedupe: true,
          });
          success += ' · archive queued';
        } catch (archiveError) {
          warning = `bookmark saved but archive could not be queued: ${(archiveError as Error).message}`;
        }
      }

      dispatch('saved', { url: url.trim(), isPublic, eventId, bookmark: savedBookmark });
      url = title = description = '';
      tags = [];
      suggestedTags = [];
      lastFetchedUrl = '';
      isPublic = $userSettings.defaultVisibility === 'public';
      crossPostToNostr = false;
      socialPostText = '';
      socialPostEdited = false;
      archiveTouched = false;
      archiveForever = defaultArchiveForever;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      saving = false;
      signerPrompt = '';
    }
  }

</script>

<div class="save-box" class:disabled={!$canSign}>
  <div class="save-url-row">
    <strong>＋ bookmark a page</strong>
    <span>or paste url:</span>
    <input
      type="text"
      placeholder="https://…"
      bind:value={url}
      on:input={scheduleFetch}
      on:blur={fetchMetadata}
      disabled={saving}
    />
  </div>
  {#if title || description || tags.length > 0 || url}
    <div class="extra">
      <input type="text" placeholder="title (optional — auto-filled)" bind:value={title} />
      <input type="text" placeholder="description (optional)" bind:value={description} />
      <TagChipInput bind:tags suggestions={suggestedTags} placeholder="tags (space or comma to add)" />
    </div>
  {/if}
  <div class="save-bottom">
    <div class="save-options">
      <label><input type="radio" name="visibility" checked={!isPublic} on:change={() => (isPublic = false)} /> 🔒 private (default — only you)</label>
      <label><input type="radio" name="visibility" checked={isPublic} on:change={() => (isPublic = true)} /> share publicly on the network</label>
      {#if canUseArchiveFlow}
        <label>
          <input
            type="checkbox"
            bind:checked={archiveForever}
            on:change={() => { archiveTouched = true; }}
          />
          archive
        </label>
      {:else if !IS_APPLE_BUILD}
        <a class="archive-note" href="/app/upgrade">archive with lifetime</a>
      {/if}
    </div>
    <div class="save-actions">
      <button class="pixel-press" on:click={save} disabled={saving || !url.trim()}>
        {saving ? 'saving…' : 'save'}
      </button>
    </div>
  </div>
  {#if isPublic}
    <div class="cross-post">
      <label>
        <input type="checkbox" checked={crossPostToNostr} on:change={onCrossPostToggle} />
        post a Nostr note too
      </label>
      {#if crossPostToNostr}
        <textarea
          rows="4"
          bind:value={socialPostText}
          on:input={() => (socialPostEdited = true)}
          placeholder="Nostr post text"
          disabled={saving}
        ></textarea>
      {/if}
    </div>
  {/if}
  {#if error}<div class="error">{error}</div>{/if}
  {#if signerPrompt}<div class="signer-prompt" aria-live="polite">{signerPrompt}</div>{/if}
  {#if success}<div class="success">{success}</div>{/if}
  {#if warning}<div class="warning">{warning}</div>{/if}
  {#if !$canSign}
    <div class="overlay" aria-live="polite">
      {#if $sessionRestoring}
        <span>Restoring your signer…</span>
      {:else if usesBrowserExtensionSession()}
        <span>🔒 Unlock your browser extension to save bookmarks</span>
      {:else}
        <span>🔒 Connect your signer to save bookmarks</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .save-box {
    background: var(--save-tint);
    border: 1px solid var(--coral-soft);
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 18px;
    font-size: 14px;
    box-shadow: 0 1px 0 rgba(255, 107, 90, 0.08);
    position: relative;
  }
  .save-url-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .save-box strong {
    color: var(--coral-deep);
    font-weight: 600;
  }
  .save-box input[type='text'] {
    padding: 8px 10px;
    font-family: inherit;
    font-size: 14px;
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: var(--surface);
    color: var(--ink);
    width: min(100%, 420px);
  }
  .save-box input[type='text']:focus {
    outline: 2px solid var(--coral-soft);
    border-color: var(--coral);
  }
  .save-box .extra {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 10px;
  }
  .save-box .extra input {
    width: 100% !important;
  }
  .save-box button {
    font-family: inherit;
    font-size: 14px;
    padding: 8px 18px;
    border: none;
    background: var(--coral);
    color: var(--on-coral);
    cursor: pointer;
    border-radius: 6px;
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
    color: var(--ink-deep);
    cursor: pointer;
  }
  .save-bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px dashed var(--rule);
  }
  .save-box .save-options {
    display: flex;
    gap: 14px;
    font-size: 13px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .archive-note {
    color: var(--ink-deep);
    text-decoration: none;
  }
  .archive-note:hover {
    color: var(--coral-deep);
  }
  .cross-post {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px dashed var(--rule);
    font-size: 13px;
  }
  .cross-post textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 14px;
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: var(--surface);
    color: var(--ink);
    resize: vertical;
  }
  .cross-post textarea:focus {
    outline: 2px solid var(--coral-soft);
    border-color: var(--coral);
  }
  .error {
    margin-top: 8px;
    color: var(--coral-deep);
    font-size: 13px;
  }
  .success {
    margin-top: 8px;
    color: var(--archive);
    font-size: 13px;
  }
  .warning {
    margin-top: 8px;
    color: #a33;
    background: rgba(196, 68, 68, 0.08);
    border-left: 3px solid #c44;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 13px;
  }
  .signer-prompt {
    margin-top: 8px;
    color: var(--ink-deep);
    background: var(--surface);
    border-left: 3px solid var(--link);
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 13px;
  }
  .save-actions {
    display: flex;
    justify-content: flex-end;
    flex-shrink: 0;
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
    .save-url-row {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
    }
    .save-box input[type='text'] {
      width: 100%;
    }
    .save-bottom {
      align-items: stretch;
      flex-direction: column;
      gap: 10px;
    }
  }
</style>
