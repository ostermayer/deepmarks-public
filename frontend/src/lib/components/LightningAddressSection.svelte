<script lang="ts">
  // Settings: lightning address edit.
  //
  // Deepmarks deliberately doesn't manage display names or bios — other
  // clients (Damus, Primal, Amethyst, etc) have purpose-built profile
  // UIs. We DO surface the lud16 because:
  //   • lnaddr powers the 80% curator leg of the zap split, so it's
  //     central to how value flows through deepmarks
  //   • users often save on deepmarks without ever opening a social
  //     nostr client, so we need an in-app way to set it
  //
  // Edit flow: read the user's current kind:0 event, replace lud16 (also
  // update the legacy `lightning_address` alias some clients emit), sign
  // + republish the whole event via the user's signer. Other profile
  // fields (name, display_name, about, picture, nip05, website…) are
  // preserved verbatim.
  //
  // If the user has no kind:0 yet, we publish a minimal one with just
  // the lud16 field — not ideal, but better than nothing.

  import { NDKEvent } from '@nostr-dev-kit/ndk';
  import { session, canSign } from '$lib/stores/session';
  import { getNdk } from '$lib/nostr/ndk';
  import { getProfile, invalidateProfile } from '$lib/nostr/profiles';
  import { KIND } from '$lib/nostr/kinds';

  $: pubkey = $session.pubkey ?? null;
  $: profile = pubkey ? getProfile(pubkey) : null;
  $: currentLn = profile ? $profile?.lud16 ?? '' : '';
  /** True when the user has a pubkey (looks signed in) but no active
   *  signer — typically an nsec session after a page reload, since we
   *  never persist the secret. UI lets them know what's up instead of
   *  showing a cryptic "no signer connected" at save time. */
  $: needsReconnect = !!pubkey && !$canSign;

  let draft = '';
  let editing = false;
  let saving = false;
  let message = '';
  let error = '';

  // Seed the draft from the profile once it loads, but only when the
  // user hasn't started editing yet. Otherwise typing gets stomped.
  $: if (!editing && currentLn && draft === '') draft = currentLn;

  function startEdit() {
    draft = currentLn;
    editing = true;
    message = '';
    error = '';
  }

  function cancel() {
    draft = currentLn;
    editing = false;
    error = '';
  }

  function isPlausibleLud16(s: string): boolean {
    const trimmed = s.trim();
    if (!trimmed) return true; // allow clearing
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed);
  }

  async function save() {
    if (!pubkey) return;
    const next = draft.trim();
    if (next === (currentLn ?? '')) {
      editing = false;
      return;
    }
    if (!isPlausibleLud16(next)) {
      error = 'doesn\'t look like a lightning address (user@domain.tld)';
      return;
    }
    error = '';
    saving = true;
    try {
      const ndk = getNdk();
      if (!ndk.signer) {
        // Nsec sessions don't survive page reloads — we never persist
        // the secret. Point the user at the login page to restore the
        // signer instead of showing a cryptic "no signer" error.
        throw new Error(
          "your signer isn't connected on this tab — sign in again to publish changes.",
        );
      }

      // Pull the current kind:0 so we don't clobber other fields.
      const existing = await ndk.fetchEvent({ kinds: [KIND.profile], authors: [pubkey] });
      let content: Record<string, unknown> = {};
      if (existing?.content) {
        try { content = JSON.parse(existing.content); } catch { /* treat as empty */ }
      }

      if (next) {
        content.lud16 = next;
        // Some older clients only read `lightning_address`. Keep the two
        // in sync so zaps work from wherever the viewer looks.
        if ('lightning_address' in content) content.lightning_address = next;
      } else {
        delete content.lud16;
        delete content.lightning_address;
      }

      const ev = new NDKEvent(ndk, {
        kind: KIND.profile,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify(content),
      });
      await ev.publish();

      // Drop the cached profile so getProfile re-reads the fresh one.
      invalidateProfile(pubkey);
      message = next ? 'lightning address updated' : 'lightning address removed';
      editing = false;
    } catch (e) {
      error = (e as Error).message ?? 'publish failed';
    } finally {
      saving = false;
    }
  }
</script>

<section>
  <h2>lightning address</h2>

  {#if !pubkey}
    <p class="muted">sign in to manage your lightning address.</p>
  {:else}
    <div class="display-row">
      {#if currentLn}
        <code class="current">{currentLn}</code>
      {:else}
        <span class="none">— not set —</span>
      {/if}
      {#if !editing}
        <button
          type="button"
          class="ghost"
          on:click={startEdit}
          disabled={needsReconnect}
          title={needsReconnect ? 'sign in again on this tab to edit' : ''}
        >{currentLn ? 'change' : 'add'}</button>
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
          type="text"
          bind:value={draft}
          placeholder="you@getalby.com"
          autocomplete="off"
          spellcheck="false"
          disabled={saving}
        />
        <button type="button" class="primary" on:click={save} disabled={saving}>
          {saving ? 'publishing…' : 'publish'}
        </button>
        <button type="button" class="ghost" on:click={cancel} disabled={saving}>cancel</button>
      </div>
      <p class="hint">we publish a kind:0 profile event to your relays; other fields (name, bio, avatar) are preserved.</p>
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
  .current {
    font-family: 'Courier New', monospace;
    font-size: 13px;
    color: var(--ink-deep);
    background: var(--paper-warm);
    padding: 4px 10px;
    border-radius: 4px;
  }
  .none { color: var(--ink); font-size: 13px; }
  .edit-row { display: flex; gap: 8px; align-items: stretch; flex-wrap: wrap; }
  .edit-row input {
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
  .edit-row input:focus { outline: 2px solid var(--coral-soft); border-color: var(--coral); }
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
  .ok { color: var(--archive); font-size: 12px; margin: 10px 0 0; }
  .err { color: #a33; font-size: 12px; margin: 10px 0 0; }
</style>
