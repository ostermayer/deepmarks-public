<script lang="ts">
  // Settings: profile picture upload + URL editor.
  //
  // We deliberately don't manage display name / about / nip05 here —
  // those are owned by purpose-built nostr clients (Damus, Primal,
  // Amethyst). But profile picture is the one piece a user really
  // wants to change *from deepmarks*: the extension links here when
  // they tap their default avatar, and asking them to bounce to a
  // separate client just to add an image is bad UX.
  //
  // Two ways to set it:
  //   • Paste a URL (already-hosted image)
  //   • Upload a file → we PUT it to blossom.deepmarks.org via BUD-01
  //     and use the returned URL
  //
  // Either way, we read the existing kind:0, merge `picture`, and
  // re-publish so other fields aren't clobbered.

  import { NDKEvent } from '@nostr-dev-kit/ndk';
  import { session, canSign } from '$lib/stores/session';
  import { getNdk } from '$lib/nostr/ndk';
  import { getProfile, invalidateProfile } from '$lib/nostr/profiles';
  import { KIND } from '$lib/nostr/kinds';
  import { uploadToBlossom } from '$lib/blossom';

  $: pubkey = $session.pubkey ?? null;
  $: profile = pubkey ? getProfile(pubkey) : null;
  $: currentPicture = profile ? $profile?.picture ?? '' : '';
  $: needsReconnect = !!pubkey && !$canSign;

  let draft = '';
  let editing = false;
  let saving = false;
  let uploading = false;
  let message = '';
  let error = '';
  let fileInput: HTMLInputElement;

  $: if (!editing && currentPicture && draft === '') draft = currentPicture;

  function startEdit() {
    draft = currentPicture;
    editing = true;
    message = '';
    error = '';
  }

  function cancel() {
    draft = currentPicture;
    editing = false;
    error = '';
  }

  function isPlausibleImageUrl(s: string): boolean {
    const trimmed = s.trim();
    if (!trimmed) return true;
    try {
      const u = new URL(trimmed);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  async function chooseFile(): Promise<void> {
    if (!fileInput) return;
    fileInput.click();
  }

  async function onFileChange(ev: Event): Promise<void> {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    // 5 MB cap — avatars don't need to be huge and we don't want to
    // mint a multi-MB BUD-01 auth + bind users to a slow upload.
    const MAX_BYTES = 5 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      error = `image too large (${(file.size / 1024 / 1024).toFixed(1)} MB) — max 5 MB`;
      return;
    }
    if (!file.type.startsWith('image/')) {
      error = 'pick an image file (png/jpg/gif/webp)';
      return;
    }
    error = '';
    uploading = true;
    try {
      const result = await uploadToBlossom(file);
      draft = result.url;
      message = 'uploaded — publish to update your profile';
    } catch (e) {
      error = (e as Error).message ?? 'upload failed';
    } finally {
      uploading = false;
      // Reset the input so picking the same file twice still fires.
      if (fileInput) fileInput.value = '';
    }
  }

  async function save() {
    if (!pubkey) return;
    const next = draft.trim();
    if (next === (currentPicture ?? '')) {
      editing = false;
      return;
    }
    if (!isPlausibleImageUrl(next)) {
      error = 'doesn\'t look like an http(s) URL';
      return;
    }
    error = '';
    saving = true;
    try {
      const ndk = getNdk();
      if (!ndk.signer) {
        throw new Error(
          "your signer isn't connected on this tab — sign in again to publish changes.",
        );
      }
      const existing = await ndk.fetchEvent({ kinds: [KIND.profile], authors: [pubkey] });
      let content: Record<string, unknown> = {};
      if (existing?.content) {
        try { content = JSON.parse(existing.content); } catch { /* treat as empty */ }
      }
      if (next) content.picture = next;
      else delete content.picture;

      const ev = new NDKEvent(ndk, {
        kind: KIND.profile,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify(content),
      });
      await ev.publish();
      invalidateProfile(pubkey);
      message = next ? 'profile picture updated' : 'profile picture removed';
      editing = false;
    } catch (e) {
      error = (e as Error).message ?? 'publish failed';
    } finally {
      saving = false;
    }
  }
</script>

<section>
  <h2>profile picture</h2>

  {#if !pubkey}
    <p class="muted">sign in to manage your profile picture.</p>
  {:else}
    <div class="display-row">
      {#if currentPicture}
        <img class="preview" src={currentPicture} alt="current profile" />
      {:else}
        <div class="preview empty">none</div>
      {/if}
      {#if !editing}
        <button
          type="button"
          class="ghost"
          on:click={startEdit}
          disabled={needsReconnect}
          title={needsReconnect ? 'sign in again on this tab to edit' : ''}
        >{currentPicture ? 'change' : 'add'}</button>
      {/if}
    </div>

    {#if needsReconnect}
      <p class="reconnect">
        your signer isn't connected on this tab — nsec sessions aren't persisted for security.
        <a href="/login?redirect=/app/settings">sign in again</a> to publish changes.
      </p>
    {:else if editing}
      <div class="edit-row">
        <input
          type="url"
          bind:value={draft}
          placeholder="https://… or upload a file →"
          autocomplete="off"
          spellcheck="false"
          disabled={saving || uploading}
        />
        <button type="button" class="ghost" on:click={chooseFile} disabled={saving || uploading}>
          {uploading ? 'uploading…' : 'upload'}
        </button>
        <button type="button" class="primary" on:click={save} disabled={saving || uploading}>
          {saving ? 'publishing…' : 'publish'}
        </button>
        <button type="button" class="ghost" on:click={cancel} disabled={saving || uploading}>cancel</button>
      </div>
      <input
        bind:this={fileInput}
        type="file"
        accept="image/*"
        on:change={onFileChange}
        style="display: none;"
      />
      {#if draft && draft !== currentPicture}
        <div class="preview-row">
          <span class="hint">preview:</span>
          <img class="preview small" src={draft} alt="new profile" />
        </div>
      {/if}
      <p class="hint">
        uploads go to blossom.deepmarks.org (your bytes, your hash). other profile fields
        (name, bio, lightning) are preserved.
      </p>
    {/if}
  {/if}

  {#if message}<p class="ok">{message}</p>{/if}
  {#if error}<p class="err">{error}</p>{/if}
</section>

<style>
  section { margin-top: 32px; }
  section h2 {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--ink-deep);
    letter-spacing: 1.5px;
    margin: 0 0 12px;
    padding-bottom: 6px;
    font-weight: 600;
    border-bottom: 1px solid var(--rule);
  }
  .muted { color: var(--ink); font-size: 13px; line-height: 1.55; margin: 0; }
  .display-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .preview {
    width: 56px; height: 56px;
    border-radius: 50%;
    object-fit: cover;
    background: var(--paper-warm);
    border: 1px solid var(--rule);
  }
  .preview.empty {
    display: flex; align-items: center; justify-content: center;
    color: var(--ink); font-size: 11px; text-transform: lowercase;
  }
  .preview.small { width: 40px; height: 40px; }
  .edit-row { display: flex; gap: 8px; align-items: stretch; flex-wrap: wrap; }
  .edit-row input[type="url"] {
    flex: 1 1 260px;
    min-width: 200px;
    padding: 8px 10px;
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: var(--surface);
    color: var(--ink-deep);
    font-family: 'Courier New', monospace;
    font-size: 13px;
  }
  .edit-row input[type="url"]:focus { outline: 2px solid var(--coral-soft); border-color: var(--coral); }
  .preview-row { display: flex; gap: 10px; align-items: center; margin-top: 10px; }
  .hint { color: var(--ink); font-size: 12px; margin: 8px 0 0; }
  .reconnect {
    margin: 10px 0 0;
    padding: 8px 12px;
    border-left: 3px solid var(--coral);
    background: var(--paper-warm);
    color: var(--ink-deep);
    font-size: 12px;
    line-height: 1.5;
    border-radius: 4px;
  }
  .reconnect a { color: var(--coral-deep); }
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
  .primary:hover:not(:disabled) { background: var(--coral-deep); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .ghost {
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--ink-deep);
    padding: 8px 16px;
    border-radius: 100px;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
  }
  .ghost:hover { border-color: var(--coral); color: var(--coral-deep); }
  .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  .ok { color: var(--archive); font-size: 12px; margin: 10px 0 0; }
  .err { color: #a33; font-size: 12px; margin: 10px 0 0; }
</style>
