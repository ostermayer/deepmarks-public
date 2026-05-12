<script lang="ts">
  // Settings: Nostr Wallet Connect (NIP-47).
  //
  // Lets the user paste a `nostr+walletconnect://…` URI from their
  // wallet (Alby Hub, Mutiny, Coinos, ZBD, …) so the site can request
  // payments without the WebLN browser-extension dance. The secret is
  // stored either in the first-party Deepmarks extension's encrypted NWC
  // store, or encrypted in localStorage when the current session has a
  // local nsec in memory.
  //
  // Once connected, ZapDialog can call payInvoice(invoice) and the
  // wallet does the actual payment over its NWC relay. We get a
  // preimage back, verify it hashes to the invoice's payment_hash,
  // and treat the payment as settled.
  //
  // Disconnect simply deletes the connection record — the wallet
  // doesn't need to be told; the URI's secret stops being used and
  // is the only thing tying our requests to that wallet.

  import { onMount } from 'svelte';
  import {
    loadNwc,
    saveNwc,
    clearNwc,
    parseNwcUri,
    type NwcConnection,
  } from '$lib/nostr/nwc-store';
  import {
    clearExtensionNwc,
    deepmarksExtensionNwc,
    loadExtensionNwc,
    saveExtensionNwc,
    type DeepmarksExtensionNwcInfo,
  } from '$lib/nostr/deepmarks-extension';
  import { currentSession, session as sessionStore } from '$lib/stores/session';

  type DisplayNwcConnection = Omit<NwcConnection, 'appSecret'> | DeepmarksExtensionNwcInfo;

  let conn: DisplayNwcConnection | null = null;
  let storageMode: 'extension' | 'site' = 'site';
  let draft = '';
  let busy = false;
  let message = '';
  let error = '';

  onMount(() => {
    void refreshConnection();
  });

  async function refreshConnection() {
    error = '';
    if (shouldUseExtensionNwc()) {
      storageMode = 'extension';
      try {
        conn = await loadExtensionNwc();
        return;
      } catch (e) {
        error = (e as Error).message;
        return;
      }
    }
    storageMode = 'site';
    try {
      conn = await loadNwc();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function connect() {
    error = '';
    message = '';
    busy = true;
    try {
      if (storageMode === 'extension' && shouldUseExtensionNwc()) {
        conn = await saveExtensionNwc(draft);
        message = 'connected and encrypted in extension';
      } else {
        const parsed = parseNwcUri(draft);
        await saveNwc(parsed);
        conn = parsed;
        message = 'connected and encrypted in this browser';
      }
      draft = '';
      setTimeout(() => { message = ''; }, 1500);
    } catch (e) {
      error = (e as Error).message ?? 'connection failed';
    } finally {
      busy = false;
    }
  }

  async function disconnect() {
    error = '';
    message = '';
    busy = true;
    try {
      if (storageMode === 'extension' && shouldUseExtensionNwc()) {
        await clearExtensionNwc();
      } else {
        clearNwc();
      }
      conn = null;
      message = 'disconnected';
      setTimeout(() => { message = ''; }, 1500);
    } finally {
      busy = false;
    }
  }

  function shouldUseExtensionNwc(): boolean {
    const signer = currentSession().signer;
    return !!deepmarksExtensionNwc() && signer?.kind !== 'nsec' && sessionStore.hint?.kind !== 'nsec';
  }
</script>

<section class="nwc">
  <h3>lightning wallet (NWC)</h3>

  {#if conn}
    <p class="hint">
      connected to wallet <code>{conn.walletPubkey.slice(0, 12)}…</code>
      via <code>{conn.relayUrl.replace(/^wss:\/\//, '')}</code>.
      lightning payments from this site will flow through this
      {storageMode === 'extension' ? 'extension wallet' : 'site wallet'}
      with no QR scanning.
    </p>
    <div class="row">
      <button type="button" class="ghost" on:click={disconnect} disabled={busy}>
        {busy ? '…' : 'disconnect'}
      </button>
      {#if message}<span class="msg">{message}</span>{/if}
    </div>
  {:else}
    <p class="hint">
      paste a <code>nostr+walletconnect://</code> URI from your wallet
      (Alby Hub, Mutiny, Coinos, ZBD, …) to enable one-tap zaps.
      {#if storageMode === 'extension'}
        the secret is encrypted in your Deepmarks extension, so it works from
        both the extension and deepmarks.org.
      {:else}
        the secret is encrypted with this browser's unlocked local signing key.
      {/if}
    </p>
    <textarea
      bind:value={draft}
      placeholder="nostr+walletconnect://..."
      rows="3"
    ></textarea>
    <div class="row">
      <button
        type="button"
        class="primary"
        on:click={() => void connect()}
        disabled={busy || !draft.trim()}
      >
        {busy ? '…' : 'connect'}
      </button>
      {#if message}<span class="msg">{message}</span>{/if}
    </div>
    {#if error}<p class="error">{error}</p>{/if}
  {/if}
</section>

<style>
  .nwc {
    margin-bottom: 32px;
  }
  h3 {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--muted);
    letter-spacing: 1.5px;
    margin: 0 0 12px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--rule);
    font-weight: 600;
  }
  .hint {
    color: var(--ink);
    font-size: 13px;
    line-height: 1.55;
    margin: 0 0 12px;
  }
  .hint code {
    font-family: 'Courier New', monospace;
    font-size: 12px;
    background: var(--surface);
    padding: 1px 6px;
    border-radius: 4px;
  }
  textarea {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--rule);
    border-radius: 4px;
    background: var(--paper);
    color: var(--ink);
    font-family: 'Courier New', monospace;
    font-size: 12px;
    resize: vertical;
    box-sizing: border-box;
    margin-bottom: 8px;
  }
  textarea:focus {
    outline: none;
    border-color: var(--link);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .primary {
    background: var(--ink-deep);
    color: var(--paper);
    border: 0;
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 500;
    border-radius: 4px;
    cursor: pointer;
  }
  .primary:hover { background: var(--coral); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .ghost {
    background: transparent;
    color: var(--ink);
    border: 1px solid var(--rule);
    padding: 6px 14px;
    font-size: 12px;
    border-radius: 4px;
    cursor: pointer;
  }
  .ghost:hover { border-color: var(--coral); color: var(--coral); }
  .msg {
    color: var(--archive);
    font-size: 12px;
  }
  .error {
    color: #a33;
    font-size: 12px;
    margin: 8px 0 0;
  }
</style>
