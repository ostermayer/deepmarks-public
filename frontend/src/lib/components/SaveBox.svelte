<script lang="ts">
  import { canSign, currentSession, session as sessionStore, sessionRestoring } from '$lib/stores/session';
  import { api, ApiError } from '$lib/api/client';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { defaultSocialPostText } from '$lib/nostr/social-post';
  import { getLifetimeStatus } from '$lib/nostr/lifetime-status';
  import { isDeepmarksExtensionAvailable } from '$lib/nostr/signers';
  import { enqueueArchivePage } from '$lib/nostr/archive';
  import { mergeBookmarkTagsWithDefaults, userSettings } from '$lib/stores/user-settings';
  import { IS_APPLE_BUILD } from '$lib/build-flags';
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import TagChipInput from './TagChipInput.svelte';
  import MentionTextarea from './MentionTextarea.svelte';

  const dispatch = createEventDispatcher<{
    saved: { url: string; isPublic: boolean; eventId: string; bookmark: ParsedBookmark };
    cancelled: void;
  }>();

  /** Optional URL to prefill — used by the /app/save route when the
   *  iOS / Android share-sheet hands us a URL via the deepmarks://
   *  scheme. When set, SaveBox skips its empty initial state and
   *  immediately runs the metadata fetch so the user sees title /
   *  description / tag suggestions on first paint. */
  export let prefillUrl: string = '';
  export let prefillTitle: string = '';
  export let prefillDescription: string = '';
  export let prefillTags: string[] = [];
  export let prefillVisibility: 'default' | 'public' | 'private' = 'default';
  export let prefillReadLater: boolean | null = null;
  export let autoSave: boolean = false;
  export let nativeMode: boolean = false;
  export let hidden: boolean = false;

  let url = prefillUrl;
  let title = prefillTitle;
  let description = prefillDescription;
  let tags: string[] = initialTags();
  let nativeTagsText = tags.filter((tag) => tag !== 'toread').join(' ');
  let suggestedTags: string[] = [];
  let isPublic = prefillVisibility === 'public'
    ? true
    : prefillVisibility === 'private'
      ? false
      : $userSettings.defaultVisibility === 'public';
  let privacyChoice: 'public' | 'private' = resolvePrivacyChoice(prefillVisibility);
  let readLater = readLaterForPrefill();
  let crossPostToNostr = false;
  let socialPostText = '';
  let socialPostEdited = false;
  let archiveForever = false;
  let archiveTouched = false;
  let saving = false;
  let error = '';
  let success = '';
  let lastFetchedUrl = '';
  let lastPrefillSignature = '';
  let lastAppliedPrefillUrl = prefillUrl;
  let defaultTagsAppliedForCurrentEntry = false;
  /** Warning text (retag failures, partial archive tagging) — rendered
   *  distinctly from the green success banner so the user doesn't read
   *  "couldn't tag the bookmark" as part of a success message. */
  let warning = '';
  let signerPrompt = '';
  let autoSaveAttempted = false;
  $: useDefaultTags = prefillTags.length === 0 && prefillReadLater === null;
  $: defaultTagsSignature = $userSettings.defaultTags.join('\u0001');

  $: lifetimeStatus = $sessionStore.pubkey ? getLifetimeStatus($sessionStore.pubkey) : null;
  $: prefillSignature = [
    prefillUrl,
    prefillTitle,
    prefillDescription,
    prefillTags.join(','),
    prefillVisibility,
    String(prefillReadLater),
  ].join('\u0001');
  $: if (
    prefillUrl.trim() &&
    prefillSignature !== lastPrefillSignature &&
    (!url.trim() || url === lastAppliedPrefillUrl)
  ) {
    applyIncomingPrefill();
  }
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
  $: if (url.trim() || defaultTagsSignature) applyDefaultTagsIfNeeded();
  $: if (autoSave && !autoSaveAttempted && url.trim() && $canSign && !$sessionRestoring) {
    autoSaveAttempted = true;
    void save();
  }

  function initialTags(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of prefillTags) {
      const tag = part.trim().replace(/^#/, '').toLowerCase();
      if (!tag || seen.has(tag) || tag.length > 48) continue;
      seen.add(tag);
      out.push(tag);
    }
    if (prefillReadLater === true && !seen.has('toread')) {
      out.push('toread');
    } else if (prefillReadLater === false) {
      return out.filter((tag) => tag !== 'toread');
    }
    return out;
  }

  function applyIncomingPrefill() {
    lastPrefillSignature = prefillSignature;
    lastAppliedPrefillUrl = prefillUrl;
    url = prefillUrl;
    title = prefillTitle;
    description = prefillDescription;
    tags = initialTags();
    nativeTagsText = tags.filter((tag) => tag !== 'toread').join(' ');
    readLater = readLaterForPrefill();
    setPrivacyChoice(resolvePrivacyChoice(prefillVisibility));
    autoSaveAttempted = false;
    defaultTagsAppliedForCurrentEntry = false;
    applyDefaultTagsIfNeeded();
    void fetchMetadata();
  }

  function applyDefaultTagsIfNeeded() {
    if (!useDefaultTags) return;
    if (!url.trim() || defaultTagsAppliedForCurrentEntry || $userSettings.defaultTags.length === 0) return;
    const next = mergeBookmarkTagsWithDefaults(tags, $userSettings.defaultTags);
    defaultTagsAppliedForCurrentEntry = true;
    if (next.length !== tags.length || next.some((tag, index) => tag !== tags[index])) {
      tags = next;
      nativeTagsText = tags.filter((tag) => tag !== 'toread').join(' ');
    }
    if (tags.includes('toread')) readLater = true;
  }

  function normalizeInputTag(raw: string): string {
    return raw
      .trim()
      .replace(/^#/, '')
      .toLowerCase()
      .replace(/[^a-z0-9.\-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/\.+$/g, '')
      .slice(0, 48);
  }

  function parseNativeTags(raw: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of raw.split(/[\s,]+/)) {
      const tag = normalizeInputTag(part);
      if (!tag || seen.has(tag) || tag === 'toread') continue;
      seen.add(tag);
      out.push(tag);
    }
    return out;
  }

  function onNativeTagsInput(event: Event) {
    nativeTagsText = (event.currentTarget as HTMLTextAreaElement).value;
    tags = parseNativeTags(nativeTagsText);
  }

  function addSuggestedTag(tag: string) {
    const normalized = normalizeInputTag(tag);
    if (!normalized || normalized === 'toread') return;
    const next = parseNativeTags(nativeTagsText);
    if (!next.includes(normalized)) next.push(normalized);
    tags = next;
    nativeTagsText = next.join(' ');
  }

  function saveTags(): string[] {
    if (!nativeMode) return tags;
    const next = tags.filter((tag) => tag !== 'toread');
    if (readLater && !next.includes('toread')) next.push('toread');
    return next;
  }

  function resolvePrivacyChoice(choice: 'default' | 'public' | 'private'): 'public' | 'private' {
    if (choice === 'public' || choice === 'private') return choice;
    return $userSettings.defaultVisibility;
  }

  function readLaterForPrefill(): boolean {
    if (prefillReadLater === true) return true;
    if (prefillReadLater === false) return false;
    return tags.includes('toread') || $userSettings.defaultTags.includes('toread');
  }

  function setPrivacyChoice(choice: 'public' | 'private') {
    privacyChoice = choice;
    isPublic = choice === 'public';
  }

  function cancelNativeSave() {
    dispatch('cancelled');
  }

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
      // Run metadata + popular-tags in parallel — both are independent,
      // both hit api.deepmarks.org, both feed the suggestion list.
      const [meta, popular] = await Promise.all([
        api.metadata(trimmed),
        api.popularTags(trimmed).catch(() => ({ url: trimmed, tags: [] as string[] })),
      ]);
      if (meta.title && !title) title = meta.title;
      if (meta.description && !description) description = meta.description;
      const merged = new Set<string>();
      for (const t of meta.suggestedTags ?? []) if (t) merged.add(t);
      for (const t of popular.tags ?? []) if (t) merged.add(t);
      if (merged.size > 0) suggestedTags = [...merged];
    } catch (e) {
      // Non-blocking — user can still type the metadata themselves.
      if (!(e instanceof ApiError)) error = (e as Error).message;
    }
  }

  /** Debounce the URL-input handler so we don't fire on every keystroke,
   *  but do fire as soon as the user pauses or pastes — no blur required. */
  let fetchDebounce: ReturnType<typeof setTimeout> | null = null;
  function scheduleFetch() {
    applyDefaultTagsIfNeeded();
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
      applyDefaultTagsIfNeeded();
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
      const tagList = saveTags();
      const sessionState = currentSession();
      const pubkey = sessionState.pubkey!;
      signerPrompt = sessionState.signer?.kind === 'nip07'
        ? 'Deepmarks is asking your browser extension to sign or encrypt this save. Approve it if prompted.'
        : '';

      const { saveBookmark } = await import('$lib/nostr/save-bookmark');
      const { rememberOwnBookmark } = await import('$lib/stores/own-bookmarks');
      const result = await saveBookmark({
        url: url.trim(),
        title,
        description,
        tags: tagList,
        isPublic,
        pubkey,
        socialPostText: isPublic && crossPostToNostr ? socialPostText : undefined,
        // Optimistic update fires synchronously inside saveBookmark
        // BEFORE any relay round-trip — the bookmark appears in the
        // user's list within a frame of clicking save, instead of
        // after the 25-chunk private-set publish completes.
        onOptimistic: (b) => rememberOwnBookmark(b, isPublic),
      });
      const eventId = result.eventId;
      const savedBookmark: ParsedBookmark = result.bookmark;

      if (isPublic) {
        success = result.publishRelayCount > 0
          ? `published to ${result.publishRelayCount} relay${result.publishRelayCount === 1 ? '' : 's'}`
          : 'saved locally; relay sync pending';
        if (result.socialRelayCount > 0) {
          success += ` · posted note to ${result.socialRelayCount} relay${result.socialRelayCount === 1 ? '' : 's'}`;
        }
        warning = [result.publishWarning, result.socialWarning].filter(Boolean).join(' · ');
      } else {
        success = 'saved privately (encrypted)';
        if (result.publishWarning) warning = `relay sync pending: ${result.publishWarning}`;
      }

      if (archiveForever && canUseArchiveFlow) {
        try {
          await enqueueArchivePage({
            url: url.trim(),
            tier: isPublic ? 'public' : 'private',
            pubkey,
            eventId: isPublic ? eventId : undefined,
            bookmarkSavedAt: savedBookmark.savedAt,
            lifetime: true,
            mirrorUrls: $userSettings.backupBlossomServers,
            dedupe: true,
          });
          success += ' · archive queued';
        } catch (archiveError) {
          warning = `bookmark saved but archive could not be queued: ${(archiveError as Error).message}`;
        }
      }

      void import('$lib/media-archive').then(({ maybeQueueMediaArchiveForBookmark }) => (
        maybeQueueMediaArchiveForBookmark({
          bookmark: savedBookmark,
          url: url.trim(),
          pubkey,
          eventId: isPublic ? eventId : undefined,
          bookmarkSavedAt: savedBookmark.savedAt,
        })
      )).catch(() => { /* media add-on queue is best-effort after save */ });

      dispatch('saved', { url: url.trim(), isPublic, eventId, bookmark: savedBookmark });
      url = title = description = '';
      tags = [];
      nativeTagsText = '';
      readLater = $userSettings.defaultTags.includes('toread');
      defaultTagsAppliedForCurrentEntry = false;
      privacyChoice = $userSettings.defaultVisibility;
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

{#if hidden}
  <!-- Native mobile saves through the plus tab, so the bookmark-list prepend can opt out. -->
{:else if nativeMode}
  <div class="native-save-form" class:disabled={!$canSign}>
    <div class="native-save-top">
      <button type="button" class="native-cancel" on:click={cancelNativeSave}>Cancel</button>
      <h1>Save Link</h1>
      <button type="button" on:click={save} disabled={saving || !url.trim() || !$canSign}>
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>

    <section class="native-section">
      <h2>URL</h2>
      <div class="native-card">
        <textarea
          rows="1"
          placeholder="https://..."
          bind:value={url}
          on:input={scheduleFetch}
          on:blur={fetchMetadata}
          disabled={saving}
        ></textarea>
        <button type="button" class="native-row-button" on:click={fetchMetadata} disabled={saving || !url.trim()}>
          AutoFill Metadata
        </button>
      </div>
    </section>

    <section class="native-section">
      <h2>TITLE</h2>
      <div class="native-card">
        <textarea rows="1" placeholder="Optional" bind:value={title} disabled={saving}></textarea>
      </div>
    </section>

    <section class="native-section">
      <h2>DESCRIPTION</h2>
      <div class="native-card">
        <textarea rows="2" placeholder="Optional" bind:value={description} disabled={saving}></textarea>
      </div>
    </section>

    <section class="native-section">
      <h2>TAGS</h2>
      <div class="native-card">
        <textarea
          rows="2"
          placeholder="Optional, space-separated. Start typing to see suggestions. Tags beginning with a period are private."
          value={nativeTagsText}
          on:input={onNativeTagsInput}
          disabled={saving}
        ></textarea>
        <button type="button" class="native-row-button with-chevron" on:click={fetchMetadata} disabled={saving || !url.trim()}>
          <span>{suggestedTags.length ? `View Suggested Tags (${suggestedTags.length})` : 'View Suggested Tags'}</span>
          <span aria-hidden="true">›</span>
        </button>
        {#if suggestedTags.length}
          <div class="native-suggestions" aria-label="suggested tags">
            {#each suggestedTags as tag}
              <button type="button" on:click={() => addSuggestedTag(tag)} disabled={saving}>{tag}</button>
            {/each}
          </div>
        {/if}
      </div>
    </section>

    <section class="native-section">
      <h2>ADVANCED</h2>
      <div class="native-card">
        <label class="native-row">
          <span>Read Later</span>
          <input class="native-switch" type="checkbox" bind:checked={readLater} disabled={saving} />
        </label>
        <div class="native-row privacy-row">
          <span>Privacy</span>
          <div class="native-segmented" aria-label="privacy">
            <button type="button" class:active={!isPublic} on:click={() => setPrivacyChoice('private')} disabled={saving}>Private</button>
            <button type="button" class:active={isPublic} on:click={() => setPrivacyChoice('public')} disabled={saving}>Public</button>
          </div>
        </div>
        {#if canUseArchiveFlow}
          <label class="native-row">
            <span>Archive</span>
            <input
              class="native-switch"
              type="checkbox"
              bind:checked={archiveForever}
              on:change={() => { archiveTouched = true; }}
              disabled={saving}
            />
          </label>
        {/if}
      </div>
    </section>

    {#if error}<div class="error">{error}</div>{/if}
    {#if signerPrompt}<div class="signer-prompt" aria-live="polite">{signerPrompt}</div>{/if}
    {#if success}<div class="success">{success}</div>{/if}
    {#if warning}<div class="warning">{warning}</div>{/if}
    {#if !$canSign}
      <div class="overlay" aria-live="polite">
        {#if $sessionRestoring}
          <span>Restoring your signer...</span>
        {:else if usesBrowserExtensionSession()}
          <span>Unlock your browser extension to save bookmarks</span>
        {:else}
          <span>Connect your signer to save bookmarks</span>
        {/if}
      </div>
    {/if}
  </div>
{:else}
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
        <label><input type="radio" name="visibility" checked={!isPublic} on:change={() => (isPublic = false)} /> 🔒 private {$userSettings.defaultVisibility === 'private' ? '(default — only you)' : '(only you)'}</label>
        <label><input type="radio" name="visibility" checked={isPublic} on:change={() => (isPublic = true)} /> share publicly {$userSettings.defaultVisibility === 'public' ? '(default)' : 'on the network'}</label>
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
{/if}

<style>
  .native-save-form {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: clamp(8px, 1.8dvh, 18px);
    color: var(--ink-deep);
  }
  .native-save-top {
    display: grid;
    grid-template-columns: 70px 1fr 70px;
    align-items: center;
    gap: 10px;
    margin-bottom: 0;
  }
  .native-save-top h1 {
    margin: 0;
    text-align: center;
    font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 17px;
    line-height: 1.1;
    color: var(--ink-deep);
  }
  .native-save-top .native-cancel,
  .native-save-top button {
    border: 0;
    background: transparent;
    color: var(--link);
    font: inherit;
    font-size: 15px;
    padding: 8px 0;
    text-decoration: none;
  }
  .native-save-top button:not(.native-cancel) {
    text-align: right;
  }
  .native-save-top .native-cancel {
    text-align: left;
  }
  .native-save-top button:disabled {
    color: var(--muted);
  }
  .native-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .native-section h2 {
    margin: 0 0 0 16px;
    color: var(--muted);
    font: inherit;
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .native-card {
    overflow: hidden;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 10px;
  }
  .native-card textarea {
    width: 100%;
    min-height: 40px;
    box-sizing: border-box;
    border: 0;
    border-bottom: 1px solid var(--rule);
    background: transparent;
    color: var(--ink-deep);
    resize: vertical;
    font: inherit;
    /* 16px is the iOS no-zoom minimum (enforced globally by
       body.native-shell textarea); below this iOS zooms in on focus. */
    font-size: 16px;
    line-height: 1.22;
    padding: 8px 12px;
    outline: none;
  }
  .native-card textarea:last-child {
    border-bottom: 0;
  }
  .native-card textarea::placeholder {
    color: color-mix(in srgb, var(--muted) 55%, transparent);
  }
  .native-row-button {
    width: 100%;
    min-height: 36px;
    border: 0;
    background: transparent;
    color: var(--link);
    font: inherit;
    font-size: 14px;
    text-align: left;
    padding: 8px 12px;
  }
  .native-row-button:disabled {
    color: var(--muted);
  }
  .native-row-button.with-chevron {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--rule);
  }
  .native-suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    max-height: 82px;
    overflow: auto;
    padding: 8px 12px 10px;
  }
  .native-suggestions button {
    border: 1px solid var(--rule);
    background: var(--paper-warm);
    color: var(--link);
    border-radius: 999px;
    padding: 4px 9px;
    font: inherit;
    font-size: 11px;
  }
  .native-row {
    min-height: 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid var(--rule);
    padding: 0 12px;
    color: var(--ink-deep);
    font-size: 14px;
  }
  .native-row:last-child {
    border-bottom: 0;
  }
  .privacy-row {
    align-items: center;
  }
  .native-segmented {
    flex: 0 0 min(62%, 280px);
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2px;
    padding: 2px;
    background: var(--paper-warm);
    border: 1px solid var(--rule);
    border-radius: 8px;
  }
  .native-segmented button {
    min-width: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--ink-deep);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 4px;
  }
  .native-segmented button.active {
    background: var(--surface);
    box-shadow: 0 1px 4px var(--shadow);
  }
  .native-switch {
    width: 48px;
    height: 28px;
    accent-color: var(--link);
  }
  .native-save-form.disabled > *:not(.overlay) {
    opacity: 0.45;
    pointer-events: none;
  }
  .native-save-form .overlay {
    background: color-mix(in srgb, var(--paper) 90%, transparent);
  }
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
    .native-save-form {
      gap: clamp(8px, 1.7dvh, 16px);
    }
    .native-save-top {
      grid-template-columns: 66px 1fr 66px;
    }
    .native-save-top h1 {
      font-size: 17px;
    }
  .native-save-top .native-cancel,
  .native-save-top button,
    .native-row-button,
    .native-card textarea,
    .native-row {
      font-size: 16px;
    }
    .privacy-row {
      align-items: center;
      flex-direction: row;
      justify-content: center;
    }
    .native-segmented {
      width: auto;
      flex-basis: min(62%, 280px);
    }
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
  @media (max-height: 720px) {
    .native-save-form {
      gap: 7px;
    }
    .native-card textarea {
      padding-top: 6px;
      padding-bottom: 6px;
    }
    .native-row-button {
      min-height: 34px;
      padding-top: 6px;
      padding-bottom: 6px;
    }
    .native-row {
      min-height: 38px;
    }
  }
</style>
