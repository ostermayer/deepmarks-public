<script lang="ts">
  // Account & Recovery: one place to understand the active Nostr identity,
  // signing access, passkey unlock, and raw recovery key backup.

  import { goto } from '$app/navigation';
  import { onDestroy, onMount } from 'svelte';
  import { nip19 } from 'nostr-tools';
  import { session, npub } from '$lib/stores/session';
  import { createNsecSigner } from '$lib/nostr/signers/nsec';
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
    prfOk = isWebAuthnAvailable() && (await isPrfSupported());
    if (pubkey) void refreshPasskeyState(pubkey);
  });

  onDestroy(() => {
    if (clearTimer) clearTimeout(clearTimer);
    nsecBech32 = '';
  });

  async function refreshPasskeyState(hexPubkey: string) {
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

  function reveal() {
    if (!nsecHex) return;
    error = '';
    try {
      const bytes = hexToUint8(nsecHex);
      nsecBech32 = nip19.nsecEncode(bytes);
      shown = true;
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = setTimeout(() => {
        shown = false;
        nsecBech32 = '';
      }, 60_000);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  function hide() {
    shown = false;
    nsecBech32 = '';
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
    const content = [
      `# Deepmarks identity recovery key`,
      `# Downloaded ${new Date().toISOString()}`,
      ``,
      `# Public identity. Safe to share.`,
      `npub: ${publicId}`,
      ``,
      `# Recovery key. Keep private. Anyone holding it controls this account.`,
      `# Deepmarks cannot reset or recover it for you.`,
      `nsec: ${nsecBech32}`,
      ``,
      `# You can import this key into any Nostr client: Damus, Primal, Amethyst,`,
      `# Alby, nsec.app, Amber, and other compatible signers.`,
    ].join('\n');
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
    if (kind === 'nsec') return 'this browser';
    if (kind === 'nip07') return 'browser extension';
    if (kind === 'nip46') return 'remote signer';
    return kind;
  }
</script>

<section>
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

  <ul class="recovery-list" aria-label="account recovery checklist">
    <li class:done={!!pubkey}>
      <strong>Public identity</strong>
      <span>{pubkey ? 'ready across Deepmarks, other Nostr apps, and relays' : 'sign in or create an identity'}</span>
    </li>
    <li class:done={!!signer} class:warn={!signer && !!session.hint}>
      <strong>Signer</strong>
      <span>{signer ? `connected through ${signerName}` : session.hint ? 'known account, signer needs reconnect' : 'not connected yet'}</span>
    </li>
    <li class:done={passkeyReady === true} class:warn={(passkeyReady === false || passkeyNeedsFinish) && !!pubkey}>
      <strong>Passkey sign-in</strong>
      <span>
        {#if passkeyReady === true}
          enabled - sign in with Face ID, Touch ID, Windows Hello, or your device unlock
        {:else if passkeyNeedsFinish}
          created - finish setup below to enable passkey sign-in
        {:else if passkeyReady === null && pubkey}
          checking passkey status...
        {:else if pubkey}
          optional - add a passkey below to protect your account and sign in quickly
        {:else}
          sign in first
        {/if}
      </span>
    </li>
    <li class:done={canReveal} class:warn={!canReveal && !!pubkey}>
      <strong>Recovery key</strong>
      <span>
        {#if canReveal}
          available on this device - back it up if you have not already
        {:else if pubkey}
          managed by your current signer; reconnect or import the key here to reveal it
        {:else}
          created during signup or imported from another signer
        {/if}
      </span>
    </li>
  </ul>

  {#if canFinishPasskey}
    <div class="subsection">
      <h3>finish passkey sign-in</h3>
      <p class="muted">
        Your passkey was created. Click finish to open the native passkey prompt
        and finish encrypting your recovery key for passkey sign-in.
      </p>
      <button class="primary" type="button" on:click={finishPasskeySetup} disabled={finishingPasskey}>
        {finishingPasskey ? 'finishing...' : 'finish passkey setup'}
      </button>
    </div>
  {:else if canAddPasskey}
    <div class="subsection">
      <h3>add passkey sign-in</h3>
      <p class="muted">
        Add a passkey to protect your account and sign in quickly with Face ID,
        Touch ID, Windows Hello, or your device unlock instead of pasting the recovery key.
      </p>
      <button class="primary" type="button" on:click={addPasskey} disabled={adding}>
        {adding ? 'adding...' : 'add passkey'}
      </button>
    </div>
  {:else if passkeyReady === true}
    <p class="ok-note">{addedMessage || 'Passkey sign-in is enabled for this identity.'}</p>
  {:else if passkeyNeedsFinish && pubkey}
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
        Your current signer does not expose the raw recovery key here. That is normal for
        extensions and remote signers; use that signer to back up or export the key.
      </p>
    {:else}
      <p class="muted">
        The recovery key is the raw Nostr <code>nsec</code>. Save it in a password manager
        or another place you control. Deepmarks cannot reset it.
      </p>
      {#if !shown}
        <button class="primary" type="button" on:click={reveal}>show recovery key</button>
      {:else}
        <div class="nsec-block">
          <code>{nsecBech32}</code>
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
  .recovery-list {
    list-style: none;
    padding: 0;
    margin: 14px 0 0;
    display: grid;
    gap: 8px;
  }
  .recovery-list li {
    display: grid;
    grid-template-columns: 132px minmax(0, 1fr);
    gap: 12px;
    padding: 9px 12px;
    background: var(--paper-warm);
    border: 1px solid var(--rule);
    border-radius: 8px;
    font-size: 13px;
    color: var(--ink-deep);
  }
  .recovery-list li.done { border-color: var(--archive); background: var(--archive-soft); }
  .recovery-list li.warn { border-color: var(--coral); background: var(--coral-soft); }
  .recovery-list strong {
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
  .nsec-block code {
    display: block;
    background: var(--surface);
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--rule);
    margin-bottom: 8px;
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
    .recovery-list li {
      grid-template-columns: 1fr;
      gap: 4px;
    }
  }
</style>
