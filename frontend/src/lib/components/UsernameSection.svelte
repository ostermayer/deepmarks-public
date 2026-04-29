<script lang="ts">
  // Lifetime-tier short handle claim / release UI.
  //
  // Shown in settings. If the caller isn't a lifetime member, we still
  // render the section with a one-line explainer + upgrade link so the
  // feature is discoverable. Once claimed, shows the URL the user can
  // share + a small "release" action.
  //
  // Availability check runs on a 300ms debounce as the user types.

  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api/client';
  import { session, canSign } from '$lib/stores/session';
  import { getUsername, invalidateUsername } from '$lib/nostr/username';

  export let isLifetime = false;

  $: pubkey = $session.pubkey ?? null;
  $: handleStore = pubkey ? getUsername(pubkey) : null;
  $: currentHandle = handleStore ? $handleStore : null;
  /** Nsec sessions don't survive page reloads (we never persist the
   *  secret). If the user looks signed in but has no signer, guide them
   *  to re-login rather than showing NIP-98 auth errors. */
  $: needsReconnect = !!pubkey && !$canSign;

  let draft = '';
  let checking = false;
  let availability:
    | { available: true }
    | { available: false; reason: 'invalid' | 'reserved' | 'taken' | 'cooldown' }
    | null = null;
  let busy = false;
  let message = '';
  let error = '';
  let debounceHandle: ReturnType<typeof setTimeout> | null = null;
  /** When the user presses "change" on an already-claimed handle we flip
   *  this so the claim UI re-appears below the current handle display. */
  let changingHandle = false;

  function resetStatus() {
    message = '';
    error = '';
  }

  function scheduleCheck(value: string) {
    if (debounceHandle) clearTimeout(debounceHandle);
    availability = null;
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      checking = false;
      return;
    }
    debounceHandle = setTimeout(async () => {
      checking = true;
      try {
        availability = await api.username.available(trimmed);
      } catch (e) {
        if (e instanceof ApiError) availability = { available: false, reason: 'invalid' };
      } finally {
        checking = false;
      }
    }, 300);
  }

  $: scheduleCheck(draft);

  async function claim() {
    resetStatus();
    if (!draft.trim()) return;
    busy = true;
    try {
      const res = await api.username.claim(draft.trim().toLowerCase());
      message = `claimed: deepmarks.org/u/${res.name}`;
      draft = '';
      availability = null;
      changingHandle = false;
      if (pubkey) invalidateUsername(pubkey);
    } catch (e) {
      error = friendlyError(e);
    } finally {
      busy = false;
    }
  }

  async function release() {
    resetStatus();
    if (!confirm('release this handle? anyone else can claim it after 30 days.')) return;
    busy = true;
    try {
      await api.username.release();
      message = 'handle released — you can reclaim it any time in the next 30 days.';
      if (pubkey) invalidateUsername(pubkey);
    } catch (e) {
      error = friendlyError(e);
    } finally {
      busy = false;
    }
  }

  function friendlyError(e: unknown): string {
    const raw = (e as Error).message ?? '';
    if (raw.toLowerCase().includes('signer required') || raw.toLowerCase().includes('no signer')) {
      return 'your signer isn\'t connected on this tab — sign in again to publish.';
    }
    if (e instanceof ApiError) {
      if (e.status === 401) return 'sign in with your signer to claim a handle';
      if (e.status === 402) return 'lifetime membership required to claim a handle';
      const m = e.message.toLowerCase();
      if (m.includes('taken')) return 'taken — pick another';
      if (m.includes('cooldown')) return 'recently released — available to the public in up to 30 days';
      if (m.includes('reserved')) return 'reserved name';
      if (m.includes('invalid')) return 'invalid format — 3–30 chars, a–z 0–9 and dashes';
    }
    return raw || 'unknown error';
  }

  onMount(() => () => {
    if (debounceHandle) clearTimeout(debounceHandle);
  });
</script>

<section>
  <h2>deepmarks handle</h2>

  {#if !pubkey}
    <p class="muted">sign in to claim a short handle.</p>
  {:else if needsReconnect}
    <p class="warn">
      your signer isn't connected on this tab — nsec sessions aren't persisted for security.
      <a href="/login?redirect=/app/settings">sign in again</a> to claim or change your handle.
    </p>
  {:else if currentHandle && !changingHandle}
    <p class="current">
      your short URL:
      <code>deepmarks.org/u/{currentHandle}</code>
    </p>
    <div class="actions">
      <button type="button" class="ghost" on:click={() => { changingHandle = true; draft = ''; resetStatus(); }} disabled={busy}>
        change handle
      </button>
      <button type="button" class="ghost" on:click={release} disabled={busy}>release handle</button>
    </div>
  {:else if currentHandle && changingHandle}
    <p class="warn">
      changing your handle releases <code>{currentHandle}</code> into the 30-day cooldown. during
      that window, only you can reclaim it — after that, anyone else can.
    </p>
    <div class="field-row">
      <div class="field-group">
        <span class="prefix">deepmarks.org/u/</span>
        <input
          type="text"
          bind:value={draft}
          placeholder="newname"
          autocomplete="off"
          spellcheck="false"
          maxlength="30"
          disabled={busy}
        />
      </div>
      <button
        type="button"
        class="primary"
        on:click={claim}
        disabled={busy || !availability || availability.available !== true}
      >
        {busy ? 'switching…' : 'switch'}
      </button>
      <button type="button" class="ghost" on:click={() => { changingHandle = false; draft = ''; resetStatus(); }} disabled={busy}>
        cancel
      </button>
    </div>
    {#if draft.trim()}
      <p class="avail-status">
        {#if checking}
          checking…
        {:else if availability?.available}
          ✓ available
        {:else if availability?.available === false}
          {#if availability.reason === 'taken'}taken — pick another
          {:else if availability.reason === 'reserved'}reserved name
          {:else if availability.reason === 'cooldown'}recently released — held for up to 30 days
          {:else}invalid format — 3–30 chars, a–z 0–9 and dashes (no leading/trailing dash){/if}
        {/if}
      </p>
    {/if}
  {:else if !isLifetime}
    <p class="muted">
      short handles are a lifetime-tier perk — <a href="/app/upgrade">upgrade</a> to claim one.
    </p>
  {:else}
    <p class="muted">
      claim a short handle so your profile lives at <code>deepmarks.org/u/&lt;name&gt;</code>.
    </p>
    <div class="field-row">
      <div class="field-group">
        <span class="prefix">deepmarks.org/u/</span>
        <input
          type="text"
          bind:value={draft}
          placeholder="yourname"
          autocomplete="off"
          spellcheck="false"
          maxlength="30"
          disabled={busy}
        />
      </div>
      <button
        type="button"
        class="primary"
        on:click={claim}
        disabled={busy || !availability || availability.available !== true}
      >
        {busy ? 'claiming…' : 'claim'}
      </button>
    </div>
    {#if draft.trim()}
      <p class="avail-status">
        {#if checking}
          checking…
        {:else if availability?.available}
          ✓ available
        {:else if availability?.available === false}
          {#if availability.reason === 'taken'}taken — pick another
          {:else if availability.reason === 'reserved'}reserved name
          {:else if availability.reason === 'cooldown'}recently released — held for up to 30 days
          {:else}invalid format — 3–30 chars, a–z 0–9 and dashes (no leading/trailing dash){/if}
        {/if}
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
  .muted { color: var(--ink); font-size: 13px; line-height: 1.55; margin: 0 0 12px; }
  .warn {
    color: var(--ink-deep);
    font-size: 12.5px;
    line-height: 1.55;
    background: var(--paper-warm);
    border-left: 3px solid var(--coral);
    padding: 8px 10px;
    border-radius: 4px;
    margin: 0 0 12px;
  }
  .warn code {
    background: rgba(255, 107, 90, 0.12);
    padding: 1px 5px;
    border-radius: 3px;
    color: var(--coral-deep);
    font-family: 'Courier New', monospace;
  }
  .current { font-size: 14px; margin: 0 0 10px; color: var(--ink-deep); }
  .current code { background: var(--paper-warm); padding: 2px 8px; border-radius: 4px; font-size: 13px; color: var(--ink-deep); }
  .actions { display: flex; gap: 8px; }
  .field-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
    flex-wrap: wrap;
  }
  .field-group {
    display: flex;
    align-items: center;
    flex: 1 1 280px;
    min-width: 220px;
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: var(--surface);
    overflow: hidden;
  }
  .field-group:focus-within {
    outline: 2px solid var(--coral-soft);
    border-color: var(--coral);
  }
  .prefix {
    color: var(--muted);
    font-size: 12px;
    padding: 0 10px;
    font-family: 'Courier New', monospace;
    border-right: 1px solid var(--rule);
    background: var(--paper-warm);
  }
  .field-group input {
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    padding: 8px 10px;
    font: inherit;
    font-size: 13px;
    color: var(--ink);
  }
  .avail-status { margin: 6px 0 0; font-size: 12px; color: var(--ink); }
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
  .primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .ghost {
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 8px 16px;
    border-radius: 100px;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
  }
  .ghost:hover { border-color: var(--coral); color: var(--coral-deep); }
  .ok { color: var(--archive); font-size: 12px; margin: 10px 0 0; }
  .err { color: var(--coral-deep); font-size: 12px; margin: 10px 0 0; }
  a { color: var(--link); }
  code { font-family: 'Courier New', monospace; font-size: 12px; }
</style>
