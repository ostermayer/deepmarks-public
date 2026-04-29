<script lang="ts">
  // Settings: "your private key" — combines two features.
  //
  //   1. Reveal nsec (always visible if we can produce one).
  //   2. Add passkey on this device (visible for nsec-active sessions
  //      that don't already have a passkey registered server-side).
  //
  // Revealing an nsec requires the nsec to be in memory — either the
  // user signed in with nsec paste (current session has `nsecHex`), or
  // they previously unlocked via passkey (same thing, the unlock writes
  // the hex into the session signer). Passkey-unlock flow doesn't
  // retain the hex between sessions; it only lives for the tab's life.

  import { onDestroy, onMount } from 'svelte';
  import { nip19 } from 'nostr-tools';
  import { session } from '$lib/stores/session';
  import {
    isPrfSupported,
    isWebAuthnAvailable,
    passkeyExistsForPubkey,
    registerPasskeyAndStoreNsec,
  } from '$lib/nostr/passkey-auth';

  let shown = false;
  let nsecBech32 = '';
  let copied = false;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  let error = '';

  let passkeyExists: boolean | null = null;
  let adding = false;
  let addedMessage = '';
  let prfOk = false;

  $: signer = $session.signer;
  $: nsecHex = signer?.kind === 'nsec' ? signer.nsecHex : undefined;
  $: pubkey = $session.pubkey;
  $: canReveal = !!nsecHex;
  $: canAddPasskey = !!nsecHex && prfOk && passkeyExists === false;

  onMount(async () => {
    prfOk = isWebAuthnAvailable() && (await isPrfSupported());
    if (pubkey) {
      try { passkeyExists = await passkeyExistsForPubkey(pubkey); }
      catch { passkeyExists = false; }
    }
  });

  onDestroy(() => {
    if (clearTimer) clearTimeout(clearTimer);
    nsecBech32 = '';
  });

  function reveal() {
    if (!nsecHex) return;
    error = '';
    try {
      const bytes = hexToUint8(nsecHex);
      nsecBech32 = nip19.nsecEncode(bytes);
      shown = true;
      // Auto-clear after 60s so a forgotten tab doesn't leave the key
      // visible on a shared screen forever.
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
      // User will select manually
    }
  }

  function download() {
    if (!nsecBech32 || !pubkey) return;
    const npub = (() => { try { return nip19.npubEncode(pubkey); } catch { return pubkey; } })();
    const content = [
      `# Deepmarks — Nostr identity backup`,
      `# Downloaded ${new Date().toISOString()}`,
      ``,
      `# Your npub is your PUBLIC identity. Safe to share.`,
      `npub: ${npub}`,
      ``,
      `# Your nsec is your PRIVATE KEY. Anyone holding it controls the account forever.`,
      `# Treat it like a seed phrase. There is no recovery if you lose it.`,
      `nsec: ${nsecBech32}`,
      ``,
      `# You can import this nsec into any Nostr client: Damus, Primal, Amethyst,`,
      `# Alby (browser extension), nsec.app, Amber, etc.`,
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deepmarks-nsec-${npub.slice(0, 12)}.txt`;
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
      await registerPasskeyAndStoreNsec(pubkey, nsecHex, 'deepmarks settings');
      addedMessage = 'passkey registered — your passkey unlocks on future sign-ins';
      passkeyExists = true;
    } catch (e) {
      error = (e as Error).message || 'passkey registration failed';
    } finally {
      adding = false;
    }
  }

  function hexToUint8(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
</script>

<section>
  <h2>your private key</h2>

  {#if !pubkey}
    <p class="muted">sign in to manage your private key.</p>
  {:else if !canReveal}
    <p class="muted">
      your signer ({signer?.kind}) doesn't expose the private key on this device — it lives in
      your {signer?.kind === 'nip07' ? 'browser extension' : signer?.kind === 'nip46' ? 'bunker' : 'signer'}.
      to get a raw nsec, paste it directly on this device first.
    </p>
  {:else}
    <p class="muted">
      your nsec is your nostr identity. back it up somewhere trusted — losing it means losing
      the account entirely (no password reset exists on nostr).
    </p>
    {#if !shown}
      <button class="primary" type="button" on:click={reveal}>reveal my nsec</button>
    {:else}
      <div class="nsec-block">
        <code>{nsecBech32}</code>
        <div class="nsec-actions">
          <button type="button" class="ghost" on:click={copy}>{copied ? 'copied ✓' : 'copy'}</button>
          <button type="button" class="ghost" on:click={download}>download .txt</button>
          <button type="button" class="ghost" on:click={hide}>hide</button>
        </div>
        <p class="nsec-hint">auto-hides in ~60s.</p>
      </div>
    {/if}
  {/if}

  {#if canAddPasskey}
    <div class="subsection">
      <h3>add passkey on this device</h3>
      <p class="muted">
        you signed in by pasting your nsec. register a passkey and we'll encrypt the nsec on
        our server (we never see the key) — next time, your passkey signs you in.
      </p>
      <button class="primary" type="button" on:click={addPasskey} disabled={adding}>
        {adding ? 'registering…' : 'add passkey'}
      </button>
      {#if addedMessage}<p class="ok">{addedMessage}</p>{/if}
    </div>
  {:else if passkeyExists === true && canReveal}
    <p class="muted subsection-note">✓ passkey registered for this npub — it signs you in on this device.</p>
  {/if}

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
  h3 {
    font-size: 13px;
    color: var(--ink-deep);
    margin: 0 0 6px;
  }
  .muted { color: var(--ink); font-size: 13px; line-height: 1.55; margin: 0 0 12px; }
  .primary { background: var(--coral); color: var(--on-coral); border: 0; padding: 8px 18px; border-radius: 100px; font-weight: 500; cursor: pointer; font-family: inherit; font-size: 13px; }
  .primary:hover:not(:disabled) { background: var(--coral-deep); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .ghost { background: transparent; border: 1px solid var(--rule); color: var(--ink-deep); padding: 6px 14px; border-radius: 100px; cursor: pointer; font-family: inherit; font-size: 12px; }
  .ghost:hover { border-color: var(--coral); color: var(--coral-deep); }
  .nsec-block {
    background: var(--zap-soft);
    border: 1px solid var(--zap);
    border-radius: 8px;
    padding: 12px 14px;
  }
  .nsec-block code {
    display: block;
    font-family: 'Courier New', monospace;
    font-size: 11px;
    color: var(--ink-deep);
    word-break: break-all;
    background: var(--surface);
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--rule);
    margin-bottom: 8px;
  }
  .nsec-actions { display: flex; gap: 6px; }
  .nsec-hint { color: var(--ink); font-size: 11px; margin: 8px 0 0; }
  .subsection { margin-top: 20px; padding-top: 16px; border-top: 1px dashed var(--rule); }
  .subsection-note { margin: 16px 0 0; color: var(--archive); font-size: 12px; }
  .ok { color: var(--archive); font-size: 12px; margin: 10px 0 0; }
  .err { color: #a33; font-size: 12px; margin: 10px 0 0; }
</style>
