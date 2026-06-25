<script lang="ts">
  // Account & Recovery: one place to understand the active Nostr identity,
  // signing access, passkey unlock, and raw recovery key backup.

  import { goto } from '$app/navigation';
  import { onDestroy, onMount } from 'svelte';
  import { nip19 } from 'nostr-tools';
  import { session, npub } from '$lib/stores/session';
  import { isNativeShell } from '$lib/native/runtime';
  import {
    hasMobileRevealPassword,
    setMobileRevealPassword,
    verifyMobileRevealPassword,
  } from '$lib/mobile/reveal-password';
  import { createNsecSigner } from '$lib/nostr/signers/nsec';
  import { buildNsecBackupText, nsecQrDataUrl } from '$lib/nostr/nsec-backup';
  import {
    finishPasskeyNsecStorage,
    isPrfSupported,
    isWebAuthnAvailable,
    passkeyStatusForPubkey,
    registerPasskeyAndStoreNsec,
    unlockNsecWithPasskey,
  } from '$lib/nostr/passkey-auth';

  let shown = false;
  let nsecBech32 = '';
  let nsecQr = '';
  let copied = false;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  let error = '';

  let passkeyReady: boolean | null = null;
  let passkeyChecked: string | null = null;
  let passkeyAvailable = false;
  let passkeyNeedsFinish = false;
  let adding = false;
  let finishingPasskey = false;
  let addedMessage = '';
  let prfOk = false;
  let unlocking = false;
  let unlockError = '';
  let nativeShell = isNativeShell();
  let revealPasswordSet: boolean | null = null;
  let revealPasswordMode: 'idle' | 'set' | 'verify' = 'idle';
  let revealPassword = '';
  let revealPasswordConfirm = '';
  let revealPasswordError = '';
  let revealPasswordBusy = false;

  $: signer = $session.signer;
  $: nsecHex = signer?.kind === 'nsec' ? signer.nsecHex : undefined;
  $: pubkey = $session.pubkey;
  $: canReveal = !!nsecHex;
  $: canAddPasskey = !!nsecHex && prfOk && passkeyReady === false && !passkeyNeedsFinish;
  $: canFinishPasskey = !!nsecHex && prfOk && passkeyNeedsFinish;
  $: signerKind = signer?.kind ?? session.hint?.kind ?? null;
  $: signerName = signerKind ? signerLabel(signerKind) : 'not connected';

  $: if (pubkey && passkeyChecked !== pubkey) {
    passkeyChecked = pubkey;
    void refreshPasskeyState(pubkey);
  }

  onMount(async () => {
    nativeShell = isNativeShell();
    if (nativeShell) {
      try {
        revealPasswordSet = await hasMobileRevealPassword();
      } catch {
        revealPasswordSet = false;
      }
      return;
    }
    prfOk = isWebAuthnAvailable() && (await isPrfSupported());
    if (pubkey) void refreshPasskeyState(pubkey);
  });

  onDestroy(() => {
    if (clearTimer) clearTimeout(clearTimer);
    nsecBech32 = '';
    nsecQr = '';
  });

  async function refreshPasskeyState(hexPubkey: string) {
    if (nativeShell) return;
    passkeyReady = null;
    passkeyAvailable = false;
    passkeyNeedsFinish = false;
    if (!isWebAuthnAvailable()) {
      passkeyReady = false;
      return;
    }
    try {
      const status = await passkeyStatusForPubkey(hexPubkey);
      passkeyReady = status.exists;
      passkeyAvailable = status.exists;
      passkeyNeedsFinish = status.hasCredential && !status.hasCiphertext;
    } catch {
      passkeyReady = false;
      passkeyAvailable = false;
      passkeyNeedsFinish = false;
    }
  }

  async function reconnectWithPasskey() {
    if (!pubkey) return;
    unlockError = '';
    unlocking = true;
    try {
      const nsecHex = await unlockNsecWithPasskey(pubkey);
      const signer = await createNsecSigner(nsecHex);
      await session.login(signer, { persistNsec: true });
    } catch (e) {
      unlockError = (e as Error).message ?? 'unlock failed';
    } finally {
      unlocking = false;
    }
  }

  function requestReveal() {
    if (!nsecHex) return;
    if (nativeShell) {
      revealPasswordMode = revealPasswordSet ? 'verify' : 'set';
      revealPassword = '';
      revealPasswordConfirm = '';
      revealPasswordError = '';
      return;
    }
    showRecoveryKey();
  }

  async function submitRevealPassword() {
    if (!nsecHex) return;
    revealPasswordBusy = true;
    revealPasswordError = '';
    try {
      if (revealPasswordMode === 'set') {
        if (revealPassword.length < 8) throw new Error('password must be at least 8 characters');
        if (revealPassword !== revealPasswordConfirm) throw new Error('passwords do not match');
        await setMobileRevealPassword(revealPassword);
        revealPasswordSet = true;
      } else {
        const ok = await verifyMobileRevealPassword(revealPassword);
        if (!ok) throw new Error('password is incorrect');
      }
      revealPasswordMode = 'idle';
      revealPassword = '';
      revealPasswordConfirm = '';
      showRecoveryKey();
    } catch (e) {
      revealPasswordError = (e as Error).message;
    } finally {
      revealPasswordBusy = false;
    }
  }

  function cancelRevealPassword() {
    revealPasswordMode = 'idle';
    revealPassword = '';
    revealPasswordConfirm = '';
    revealPasswordError = '';
  }

  function showRecoveryKey() {
    if (!nsecHex) return;
    error = '';
    try {
      const bytes = hexToUint8(nsecHex);
      nsecBech32 = nip19.nsecEncode(bytes);
      nsecQr = '';
      shown = true;
      void nsecQrDataUrl(nsecBech32).then((url) => {
        if (shown && nsecBech32) nsecQr = url;
      }).catch(() => {
        nsecQr = '';
      });
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = setTimeout(() => {
        shown = false;
        nsecBech32 = '';
        nsecQr = '';
      }, 60_000);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  function hide() {
    shown = false;
    nsecBech32 = '';
    nsecQr = '';
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(nsecBech32);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // User will select manually.
    }
  }

  function download() {
    if (!nsecBech32 || !pubkey) return;
    const publicId = (() => { try { return nip19.npubEncode(pubkey); } catch { return pubkey; } })();
    const content = buildNsecBackupText({
      npub: publicId,
      nsec: nsecBech32,
      timestampLabel: 'Downloaded',
    });
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deepmarks-recovery-key-${publicId.slice(0, 12)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function addPasskey() {
    if (!nsecHex || !pubkey) return;
    adding = true;
    error = '';
    addedMessage = '';
    try {
      const result = await registerPasskeyAndStoreNsec(pubkey, nsecHex, 'deepmarks settings');
      if (result.needsSecondStep) {
        addedMessage = 'passkey created - finish setup below to enable passkey sign-in';
        passkeyReady = false;
        passkeyAvailable = false;
        passkeyNeedsFinish = true;
        return;
      }
      addedMessage = 'passkey sign-in enabled - future sign-ins can use your device unlock';
      passkeyReady = true;
      passkeyAvailable = true;
      passkeyNeedsFinish = false;
    } catch (e) {
      error = (e as Error).message || 'passkey registration failed';
    } finally {
      adding = false;
    }
  }

  async function finishPasskeySetup() {
    if (!nsecHex || !pubkey) return;
    finishingPasskey = true;
    error = '';
    addedMessage = '';
    try {
      await finishPasskeyNsecStorage(pubkey, nsecHex);
      addedMessage = 'passkey sign-in enabled - future sign-ins can use your device unlock';
      passkeyReady = true;
      passkeyAvailable = true;
      passkeyNeedsFinish = false;
    } catch (e) {
      error = (e as Error).message || 'passkey setup could not be finished';
    } finally {
      finishingPasskey = false;
    }
  }

  function hexToUint8(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function signerLabel(kind: string): string {
    if (kind === 'nsec') return nativeShell ? 'this device' : 'this browser';
    if (kind === 'nip07') return 'browser extension';
    if (kind === 'nip46') return 'remote signer';
    if (kind === 'android') return 'Android signer';
    return kind;
  }

  function methodDescription(kind: string | null, hasSigner: boolean): string {
    if (!kind) return 'Sign in to manage account recovery.';
    if (!hasSigner) return `Signed in before with ${signerLabel(kind)}; open the login screen if signing is needed.`;
    if (kind === 'nsec') return nativeShell
      ? 'Signed in with the recovery key stored on this device.'
      : 'Signed in with the recovery key stored in this browser.';
    if (kind === 'nip07') return 'Signed in with a browser extension. Key backup and approvals stay in that extension.';
    if (kind === 'nip46') return 'Signed in with a remote signer. Key backup and approvals stay with that signer.';
    if (kind === 'android') return 'Signed in with an Android signer. Key backup and approvals stay in that signer app.';
    return `Signed in with ${signerLabel(kind)}.`;
  }
</script>

<section class="settings-band">
  <h2>account & recovery</h2>
  <p class="intro">
    This is your Deepmarks identity on Nostr. Your public identity can be shared anywhere;
    your recovery key must stay private.
  </p>

  <div class="identity-grid">
    <div class="identity-row">
      <span class="label">public identity</span>
      <code>{$npub ?? 'not signed in'}</code>
    </div>
    <div class="identity-row">
      <span class="label">signing access</span>
      {#if signer}
        <span class="ok">ready - {signerName}</span>
      {:else if session.hint}
        {#if passkeyAvailable}
          <span class="warn">
            <span>locked - unlock to publish</span>
            <button type="button" class="inline-btn" on:click={reconnectWithPasskey} disabled={unlocking}>
              {unlocking ? 'unlocking...' : 'unlock with passkey'}
            </button>
          </span>
        {:else}
          <span class="warn">
            <span>reconnect needed - {signerName}</span>
            <button type="button" class="inline-btn" on:click={() => goto(`/login?redirect=${encodeURIComponent('/app/settings')}`)}>
              reconnect
            </button>
          </span>
        {/if}
      {:else}
        <span class="warn">
          <span>not connected</span>
          <button type="button" class="inline-btn" on:click={() => goto('/login')}>sign in</button>
        </span>
      {/if}
    </div>
  </div>
  {#if unlockError}
    <p class="err">{unlockError}</p>
  {/if}

  <div class="method-summary">
    <strong>current sign-in method</strong>
    <span>{methodDescription(signerKind, !!signer)}</span>
  </div>

  {#if !nativeShell && canFinishPasskey}
    <div class="subsection">
      <h3>finish passkey protection</h3>
      <p class="muted">
        Your passkey was created. Click finish to open the native passkey prompt
        and finish encrypting your recovery key for this browser.
      </p>
      <button class="primary" type="button" on:click={finishPasskeySetup} disabled={finishingPasskey}>
        {finishingPasskey ? 'finishing...' : 'finish passkey setup'}
      </button>
    </div>
  {:else if !nativeShell && canAddPasskey}
    <div class="subsection">
      <h3>protect this browser with a passkey</h3>
      <p class="muted">
        Add a passkey so this browser can unlock with Face ID, Touch ID,
        Windows Hello, or your device unlock instead of pasting the recovery key.
      </p>
      <button class="primary" type="button" on:click={addPasskey} disabled={adding}>
        {adding ? 'adding...' : 'add passkey'}
      </button>
    </div>
  {:else if !nativeShell && passkeyReady === true}
    <p class="ok-note">{addedMessage || 'Passkey sign-in is enabled for this identity.'}</p>
  {:else if !nativeShell && passkeyNeedsFinish && pubkey}
    <p class="warn-note">
      Passkey setup is incomplete. Reconnect with the recovery key on this browser to finish it.
    </p>
  {/if}

  <div class="subsection">
    <h3>recovery key backup</h3>
    {#if !pubkey}
      <p class="muted">sign in to manage your recovery key.</p>
    {:else if !canReveal}
      <p class="muted">
        Your current sign-in method manages the recovery key outside this page. That is
        normal for browser extensions and remote signers; use that signer to back up or
        export the key.
      </p>
    {:else}
      <p class="muted">
        The recovery key is the raw Nostr <code>nsec</code>. Save it in a password manager
        or another place you control. Deepmarks cannot reset it.
      </p>
      {#if revealPasswordMode !== 'idle'}
        <div class="password-form">
          <p class="muted">
            {#if revealPasswordMode === 'set'}
              Set a password for recovery-key reveal on this device. The app will ask for it every time, even when you are already signed in.
            {:else}
              Enter your recovery-key reveal password. The app asks every time so an unlocked session does not expose the raw key.
            {/if}
          </p>
          <input
            class="password-input"
            type="password"
            placeholder={revealPasswordMode === 'set' ? 'new password' : 'password'}
            bind:value={revealPassword}
            on:keydown={(e) => e.key === 'Enter' && revealPasswordMode === 'verify' && submitRevealPassword()}
          />
          {#if revealPasswordMode === 'set'}
            <input
              class="password-input"
              type="password"
              placeholder="confirm password"
              bind:value={revealPasswordConfirm}
              on:keydown={(e) => e.key === 'Enter' && submitRevealPassword()}
            />
          {/if}
          <div class="form-actions">
            <button type="button" class="ghost" on:click={cancelRevealPassword} disabled={revealPasswordBusy}>cancel</button>
            <button type="button" class="primary" on:click={submitRevealPassword} disabled={revealPasswordBusy}>
              {revealPasswordBusy ? 'checking...' : revealPasswordMode === 'set' ? 'set password & show key' : 'show key'}
            </button>
          </div>
          {#if revealPasswordError}<p class="err">{revealPasswordError}</p>{/if}
        </div>
      {:else if !shown}
        <button class="primary" type="button" on:click={requestReveal}>show recovery key</button>
      {:else}
        <div class="nsec-block">
          <code>{nsecBech32}</code>
          {#if nsecQr}
            <img class="nsec-qr" src={nsecQr} alt="Recovery key QR code" />
          {/if}
          <div class="nsec-actions">
            <button type="button" class="ghost" on:click={copy}>{copied ? 'copied' : 'copy'}</button>
            <button type="button" class="ghost" on:click={download}>download .txt</button>
            <button type="button" class="ghost" on:click={hide}>hide</button>
          </div>
          <p class="nsec-hint">Auto-hides in about 60 seconds.</p>
        </div>
      {/if}
    {/if}
  </div>

  {#if error}<p class="err">{error}</p>{/if}
</section>

<style>
  section { margin-top: 32px; }
  section h2 {
    font-size: 12px;
    text-transform: uppercase;
    color: var(--ink-deep);
    letter-spacing: 0;
    margin: 0 0 12px;
    padding-bottom: 6px;
    font-weight: 600;
    border-bottom: 1px solid var(--rule);
  }
  h3 {
    font-size: 15px;
    color: var(--ink-deep);
    margin: 0 0 6px;
  }
  .intro,
  .muted {
    color: var(--ink-deep);
    font-size: 14px;
    line-height: 1.6;
    margin: 0 0 12px;
  }
  .identity-grid {
    border: 1px solid var(--rule);
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface);
  }
  .identity-row {
    display: grid;
    grid-template-columns: 132px minmax(0, 1fr);
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--rule);
    align-items: center;
    font-size: 14px;
  }
  .identity-row:last-child { border-bottom: 0; }
  .label {
    color: var(--ink);
    font-weight: 600;
  }
  code {
    font-family: 'Courier New', monospace;
    font-size: 12px;
    color: var(--ink-deep);
    word-break: break-all;
  }
  .ok,
  .ok-note {
    color: var(--archive);
    font-size: 13px;
  }
  .ok-note { margin: 12px 0 0; }
  .warn-note {
    color: var(--coral-deep);
    background: var(--coral-soft);
    border: 1px solid var(--coral);
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 13px;
    line-height: 1.5;
    margin: 12px 0 0;
  }
  .warn {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    color: var(--coral-deep);
  }
  .inline-btn {
    background: transparent;
    border: 1px solid var(--coral);
    color: var(--coral);
    padding: 4px 10px;
    border-radius: 100px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
  }
  .inline-btn:hover { background: var(--coral); color: var(--on-coral); }
  .inline-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .method-summary {
    display: grid;
    grid-template-columns: 132px minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    margin: 14px 0 0;
    padding: 10px 12px;
    background: var(--paper-warm);
    border: 1px solid var(--rule);
    border-radius: 8px;
    font-size: 13px;
    color: var(--ink-deep);
  }
  .method-summary strong {
    color: var(--ink-deep);
    font-size: 13px;
  }
  .subsection {
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px dashed var(--rule);
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
    font-size: 14px;
  }
  .primary:hover:not(:disabled) { background: var(--coral-deep); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .ghost {
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--ink-deep);
    padding: 6px 14px;
    border-radius: 100px;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
  }
  .ghost:hover { border-color: var(--coral); color: var(--coral-deep); }
  .nsec-block {
    background: var(--zap-soft);
    border: 1px solid var(--zap);
    border-radius: 8px;
    padding: 12px 14px;
  }
  .password-form {
    display: grid;
    gap: 8px;
    padding: 12px 14px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--paper-warm);
  }
  .password-form .muted { margin-bottom: 0; }
  .password-input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink-deep);
    font: inherit;
    font-size: 14px;
    padding: 9px 11px;
  }
  .form-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .nsec-block code {
    display: block;
    background: var(--surface);
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--rule);
    margin-bottom: 8px;
  }
  .nsec-qr {
    display: block;
    width: 180px;
    height: 180px;
    margin: 0 0 10px;
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: #fff;
  }
  .nsec-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .nsec-hint {
    color: var(--ink-deep);
    font-size: 12px;
    margin: 8px 0 0;
  }
  .err {
    color: #a33;
    font-size: 13px;
    line-height: 1.5;
    margin: 10px 0 0;
  }

  @media (max-width: 560px) {
    .identity-row,
    .method-summary {
      grid-template-columns: 1fr;
      gap: 4px;
    }
  }
</style>
