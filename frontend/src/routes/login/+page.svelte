<script lang="ts">
  // Passkey-first login. Layout (top → bottom):
  //
  //   [Sign in with passkey] — discoverable-credential flow. The OS picker
  //     shows every deepmarks passkey on this device; user picks one, the
  //     assertion's userHandle gives us the pubkey, PRF gives us the
  //     decryption key for the stored nsec. No npub paste, no lookup step.
  //
  //   Other ways to sign in (for nostr-savvy users):
  //     - browser extension (NIP-07)
  //     - remote bunker (NIP-46)
  //     - paste nsec (offers passkey storage for this device)
  //
  // Redirect target is preserved across sign-in.

  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { nip19 } from 'nostr-tools';
  import { bytesToHex } from '@noble/hashes/utils';
  import Logo from '$lib/components/Logo.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import {
    createNip07Signer,
    createNip46Signer,
    createNsecSigner,
    isNip07Available,
    SignerError,
  } from '$lib/nostr/signers';
  import { session } from '$lib/stores/session';
  import { hasChosenTier } from '$lib/onboarding';
  import {
    cancelPendingPasskeyCall,
    isPrfSupported,
    isWebAuthnAvailable,
    registerPasskeyAndStoreNsec,
    unlockNsecWithPasskeyDiscoverable,
  } from '$lib/nostr/passkey-auth';

  type Method = null | 'passkey' | 'extension' | 'bunker' | 'nsec';
  let active: Method = 'passkey';
  let error = '';
  let info = '';
  let working = false;

  let bunkerUri = '';
  let nsecInput = '';
  let pasteSaveWithPasskey = true;

  $: redirectTarget = safeRedirect($page.url.searchParams.get('redirect'));
  $: extAvailable = typeof window !== 'undefined' ? isNip07Available() : false;

  function safeRedirect(raw: string | null): string {
    if (!raw) return '/app';
    if (!raw.startsWith('/') || raw.startsWith('//')) return '/app';
    return raw;
  }

  /** First-sign-in users go through /welcome to pick a tier; subsequent
   *  sign-ins jump straight to the redirect target. The flag is
   *  localStorage so it's per-device — a user signing in on a fresh
   *  browser sees the picker again. That's fine; they can pick "free"
   *  in two clicks. */
  function nextRouteAfterLogin(): string {
    return hasChosenTier() ? redirectTarget : '/welcome';
  }

  async function loginWithPasskey() {
    error = '';
    info = '';
    if (!isWebAuthnAvailable()) { error = 'your browser does not support passkeys'; return; }
    working = true;
    try {
      info = 'approve the passkey prompt to unlock…';
      const { nsecHex } = await unlockNsecWithPasskeyDiscoverable();
      const signer = await createNsecSigner(nsecHex);
      await session.login(signer);
      void goto(nextRouteAfterLogin());
    } catch (e) {
      error = (e as Error).message || 'passkey unlock failed';
      info = '';
    } finally {
      working = false;
    }
  }

  async function loginExt() {
    error = '';
    working = true;
    try {
      const s = await createNip07Signer();
      await session.login(s);
      void goto(nextRouteAfterLogin());
    } catch (e) {
      error = e instanceof SignerError ? e.message : (e as Error).message;
    } finally {
      working = false;
    }
  }

  async function loginBunker() {
    error = '';
    working = true;
    try {
      const s = await createNip46Signer(bunkerUri.trim());
      await session.login(s);
      void goto(nextRouteAfterLogin());
    } catch (e) {
      error = e instanceof SignerError ? e.message : (e as Error).message;
    } finally {
      working = false;
    }
  }

  async function loginNsec() {
    error = '';
    working = true;
    try {
      const s = await createNsecSigner(nsecInput);
      await session.login(s);
      // Optional: save for Face-ID-unlock on this device next time.
      if (pasteSaveWithPasskey && isWebAuthnAvailable() && (await isPrfSupported())) {
        try {
          const d = nip19.decode(nsecInput.trim());
          const hex = d.type === 'nsec' ? bytesToHex(d.data) : '';
          if (hex) await registerPasskeyAndStoreNsec(s.pubkey, hex, 'deepmarks login');
        } catch {
          // Passkey save failed — session still alive, user can try later
          // from settings.
        }
      }
      nsecInput = '';
      void goto(nextRouteAfterLogin());
    } catch (e) {
      error = e instanceof SignerError ? e.message : (e as Error).message;
    } finally {
      working = false;
    }
  }
</script>

<svelte:head><title>Sign in — Deepmarks</title></svelte:head>

<div class="page">
  <a href="/" class="back"><Logo size={20} flip /> back</a>
  <h1>sign in</h1>
  <p class="lede">
    new here? <a href="/signup">create an identity</a>.
  </p>

  <div class="methods">
    <!-- Passkey (primary) -->
    <button
      type="button"
      class="method primary-method"
      class:open={active === 'passkey'}
      on:click={() => (active = active === 'passkey' ? null : 'passkey')}
    >
      <div class="title">sign in with passkey <span class="rec">recommended</span></div>
      <div class="sub">use your device passkey (Face ID / Touch ID / Windows Hello) — fastest if you signed up here</div>
    </button>
    {#if active === 'passkey'}
      <div class="panel">
        <p class="muted">your device will show a passkey picker — pick the deepmarks one and you're in. no npub paste needed.</p>
        <div class="passkey-row">
          <button class="primary" on:click={loginWithPasskey} disabled={working}>
            {working ? (info || 'unlocking…') : 'unlock with passkey'}
          </button>
          {#if working}
            <button type="button" class="ghost-inline" on:click={cancelPendingPasskeyCall}>cancel</button>
          {/if}
        </div>
        {#if info && working}<p class="info">{info}</p>{/if}
        {#if working}
          <p class="info">
            if nothing happens: a password-manager extension (Bitwarden, 1Password) may be
            intercepting the prompt. unlock it or click cancel to try a different method.
          </p>
        {/if}
      </div>
    {/if}

    <!-- Extension -->
    <button
      type="button"
      class="method"
      class:open={active === 'extension'}
      on:click={() => (active = active === 'extension' ? null : 'extension')}
    >
      <div class="title">browser extension</div>
      <div class="sub">Alby · nos2x · Flamingo — nsec stays in the extension</div>
    </button>
    {#if active === 'extension'}
      <div class="panel">
        {#if extAvailable}
          <button class="primary" on:click={loginExt} disabled={working}>
            {working ? 'asking extension…' : 'continue with extension'}
          </button>
        {:else}
          <p class="muted">No NIP-07 extension detected. Install Alby (recommended) and reload.</p>
        {/if}
      </div>
    {/if}

    <!-- Bunker -->
    <button
      type="button"
      class="method"
      class:open={active === 'bunker'}
      on:click={() => (active = active === 'bunker' ? null : 'bunker')}
    >
      <div class="title">remote bunker (NIP-46)</div>
      <div class="sub">Amber · nsec.app · self-hosted — nsec stays on your bunker</div>
    </button>
    {#if active === 'bunker'}
      <div class="panel">
        <input
          type="text"
          placeholder="bunker://npub1…?relay=wss://…&secret=…"
          bind:value={bunkerUri}
        />
        <button class="primary" on:click={loginBunker} disabled={working || !bunkerUri.trim()}>
          {working ? 'connecting…' : 'connect bunker'}
        </button>
      </div>
    {/if}

    <!-- Paste nsec -->
    <button
      type="button"
      class="method"
      class:open={active === 'nsec'}
      on:click={() => (active = active === 'nsec' ? null : 'nsec')}
    >
      <div class="title">paste nsec <span class="warn">advanced</span></div>
      <div class="sub">we'll offer to remember it with a passkey so reload doesn't re-prompt</div>
    </button>
    {#if active === 'nsec'}
      <div class="panel">
        <input
          type="password"
          placeholder="nsec1… or 64-char hex"
          bind:value={nsecInput}
          autocomplete="off"
          spellcheck="false"
        />
        {#await isPrfSupported() then prfOk}
          {#if prfOk}
            <label class="check">
              <input type="checkbox" bind:checked={pasteSaveWithPasskey} />
              remember on this device with a passkey
            </label>
          {/if}
        {/await}
        <button class="primary" on:click={loginNsec} disabled={working || !nsecInput.trim()}>
          {working ? 'verifying…' : 'sign in with nsec'}
        </button>
      </div>
    {/if}
  </div>

  {#if error}<div class="error">{error}</div>{/if}
</div>

<Footer />

<style>
  .page { max-width: 540px; margin: 0 auto; padding: 60px 24px 40px; position: relative; }
  .back {
    position: absolute; top: 20px; left: 24px;
    display: inline-flex; align-items: center; gap: 8px;
    color: var(--muted) !important; font-size: 12px; text-decoration: none;
  }
  .back:hover { color: var(--coral) !important; text-decoration: none; }
  h1 { font-family: 'Space Grotesk', Inter, sans-serif; font-size: 32px; color: var(--ink-deep); margin: 0; letter-spacing: -0.4px; }
  .lede { color: var(--ink); margin: 8px 0 24px; font-size: 14px; }
  .methods { display: flex; flex-direction: column; gap: 0; }
  .method {
    text-align: left; background: var(--surface);
    border: 1px solid var(--rule); border-radius: 10px;
    padding: 14px 16px; cursor: pointer; margin-bottom: 8px;
    font-family: inherit;
  }
  .method.primary-method { border-color: var(--coral); background: var(--coral-soft); }
  .method:hover, .method.open { border-color: var(--coral); }
  .method .title { font-weight: 600; color: var(--ink-deep); font-size: 14px; display: flex; align-items: center; gap: 8px; }
  .method .sub { font-size: 12px; color: var(--ink); margin-top: 2px; line-height: 1.5; }
  .rec { background: var(--archive-soft); color: var(--archive); font-size: 9px; text-transform: uppercase; letter-spacing: 0.6px; padding: 1px 7px; border-radius: 10px; font-weight: 600; }
  .warn { background: var(--zap-soft); color: var(--zap); font-size: 9px; text-transform: uppercase; letter-spacing: 0.6px; padding: 1px 7px; border-radius: 10px; font-weight: 600; }
  .panel {
    margin: -4px 0 12px; padding: 14px 16px;
    background: var(--paper-warm);
    border: 1px solid var(--rule); border-top: 0;
    border-radius: 0 0 10px 10px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .panel input {
    width: 100%; box-sizing: border-box;
    padding: 8px 10px;
    border: 1px solid var(--rule); border-radius: 6px;
    background: var(--surface); color: var(--ink-deep);
    font-family: 'Courier New', monospace; font-size: 12px;
  }
  .panel input:focus { outline: 2px solid var(--coral-soft); border-color: var(--coral); }
  .check { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-deep); cursor: pointer; }
  .check input { width: auto; margin: 0; flex-shrink: 0; }
  .primary {
    background: var(--coral); color: var(--on-coral); border: 0;
    padding: 9px 14px; border-radius: 100px;
    font-weight: 500; cursor: pointer; font-family: inherit; font-size: 13px;
    align-self: flex-start;
  }
  .primary:hover:not(:disabled) { background: var(--coral-deep); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .muted { color: var(--ink); font-size: 13px; margin: 0; }
  .info { color: var(--ink-deep); font-size: 12px; margin: 4px 0 0; font-style: italic; }
  .passkey-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .ghost-inline { background: transparent; border: 1px solid var(--rule); color: var(--ink-deep); padding: 7px 14px; border-radius: 100px; font: inherit; font-size: 12px; cursor: pointer; }
  .ghost-inline:hover { border-color: var(--coral); color: var(--coral-deep); }
  .error {
    margin-top: 16px; padding: 10px 14px;
    background: var(--coral-soft); color: var(--coral-deep);
    border-radius: 8px; font-size: 13px;
  }
</style>
