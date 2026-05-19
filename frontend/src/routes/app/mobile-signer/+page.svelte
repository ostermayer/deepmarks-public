<script lang="ts">
  import { page } from '$app/stores';
  import { onDestroy, onMount, tick } from 'svelte';
  import { nip19 } from 'nostr-tools';
  import {
    clearMobileSignerAccount,
    loadMobileSignerAccount,
    saveMobileSignerNsec,
    type MobileSignerAccount,
  } from '$lib/mobile/signer-account';
  import {
    loadMobileSignerConnections,
    mobileSignerStatus,
    pairNostrConnect,
    removeMobileSignerConnection,
    restartMobileSignerService,
    type MobileSignerConnection,
  } from '$lib/mobile/nip46-service';
  import {
    getPendingNostrSignerRequest,
    rejectNostrSignerRequest,
    type PendingNostrSignerRequest,
  } from '$lib/mobile/secure-store';
  import { qrScannerUnavailableMessage, startVideoQrScanner, type StopQrScanner } from '$lib/mobile/qr-scanner';
  import { Capacitor } from '@capacitor/core';

  let account: MobileSignerAccount | null = null;
  let connections: MobileSignerConnection[] = [];
  let nsecInput = '';
  let connectInput = '';
  let status = '';
  let error = '';
  let scanning = false;
  let videoEl: HTMLVideoElement | null = null;
  let stopQrScanner: StopQrScanner | null = null;
  let pendingNip55: PendingNostrSignerRequest | null = null;
  let autoPairedConnectParam = '';

  $: connectParam = $page.url.searchParams.get('connect') ?? '';
  $: npub = account ? nip19.npubEncode(account.pubkey) : '';
  $: nativeShell = typeof window !== 'undefined' ? Capacitor.isNativePlatform() : false;

  onMount(() => {
    void refresh();
    const timer = setInterval(() => {
      void refreshPendingNip55();
    }, 1500);
    return () => clearInterval(timer);
  });

  onDestroy(() => {
    stopScan();
  });

  $: if (connectParam && connectParam !== connectInput && connectParam !== autoPairedConnectParam) {
    connectInput = connectParam;
  }
  $: if (connectParam && account && autoPairedConnectParam !== connectParam) {
    autoPairedConnectParam = connectParam;
    connectInput = connectParam;
    void pairConnect();
  }

  async function refresh(): Promise<void> {
    account = await loadMobileSignerAccount();
    connections = await loadMobileSignerConnections();
    await restartMobileSignerService();
    await refreshPendingNip55();
  }

  async function refreshPendingNip55(): Promise<void> {
    pendingNip55 = await getPendingNostrSignerRequest();
  }

  async function saveKey(): Promise<void> {
    error = '';
    status = '';
    try {
      account = await saveMobileSignerNsec(nsecInput);
      nsecInput = '';
      status = 'mobile signer key saved';
      await refresh();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function clearKey(): Promise<void> {
    error = '';
    status = '';
    await clearMobileSignerAccount();
    account = null;
    status = 'mobile signer key removed';
    await refresh();
  }

  async function pairConnect(): Promise<void> {
    error = '';
    status = '';
    try {
      if (!account) throw new Error('add your mobile signer key first');
      const connection = await pairNostrConnect(connectInput);
      connectInput = '';
      connections = await loadMobileSignerConnections();
      status = `paired ${connection.name || shortKey(connection.clientPubkey)}`;
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function removeConnection(pubkey: string): Promise<void> {
    await removeMobileSignerConnection(pubkey);
    connections = await loadMobileSignerConnections();
    status = 'connection removed';
  }

  async function rejectAndroidRequest(): Promise<void> {
    if (!pendingNip55) return;
    await rejectNostrSignerRequest(pendingNip55.requestId);
    pendingNip55 = null;
    status = 'request rejected';
  }

  async function startScan(): Promise<void> {
    error = '';
    const unavailable = qrScannerUnavailableMessage();
    if (unavailable) {
      error = `${unavailable} Paste the nostrconnect link instead.`;
      return;
    }
    try {
      scanning = true;
      await tick();
      if (!videoEl) throw new Error('camera preview did not start');
      stopQrScanner = await startVideoQrScanner(videoEl, async (value) => {
        scanning = false;
        stopQrScanner = null;
        connectInput = value;
        await pairConnect();
      });
    } catch (e) {
      stopScan();
      error = (e as Error).message;
    }
  }

  function stopScan(): void {
    scanning = false;
    stopQrScanner?.();
    stopQrScanner = null;
  }

  function shortKey(pubkey: string): string {
    return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
  }
</script>

<svelte:head><title>mobile signer — Deepmarks</title></svelte:head>

<div class="page">
  <a class="back" href="/app/settings">← settings</a>
  <h1>mobile signer</h1>
  <p class="lede">
    Pair this app with NIP-46 clients. The signer only runs while the mobile app is open.
  </p>

  <section>
    <h2>device key</h2>
    {#if account}
      <div class="account">
        <strong>{shortKey(account.pubkey)}</strong>
        <code>{npub}</code>
      </div>
      <p class="muted">
        Stored in {nativeShell ? 'the platform secure store' : 'local browser storage for web preview'}.
      </p>
      <button type="button" class="ghost" on:click={clearKey}>remove key</button>
    {:else}
      <div class="entry-row">
        <input
          type="password"
          bind:value={nsecInput}
          placeholder="nsec1… or 64-character hex secret"
          autocomplete="off"
          spellcheck="false"
        />
        <button class="primary" type="button" disabled={!nsecInput.trim()} on:click={saveKey}>
          save key
        </button>
      </div>
      <p class="muted">iOS saves this in Keychain; Android encrypts it with an Android Keystore key.</p>
    {/if}
  </section>

  <section>
    <h2>pair client</h2>
    <div class="entry-row">
    <input
      type="text"
      bind:value={connectInput}
      placeholder="nostrconnect://client-pubkey?relay=wss://…&secret=…"
        spellcheck="false"
      />
      <button class="primary" type="button" disabled={!connectInput.trim() || !account} on:click={pairConnect}>
        pair
      </button>
    </div>
    <div class="actions">
      <button class="ghost" type="button" on:click={startScan} disabled={!account || scanning}>scan QR</button>
      {#if scanning}<button class="ghost" type="button" on:click={stopScan}>stop camera</button>{/if}
    </div>
    {#if scanning}<video bind:this={videoEl} muted playsinline class="scanner" title="QR scanner"></video>{/if}
  </section>

  <section>
    <h2>status</h2>
    <div class="status-grid">
      <span>service</span><strong>{$mobileSignerStatus.running ? 'listening' : 'stopped'}</strong>
      <span>relays</span><strong>{$mobileSignerStatus.relayCount}</strong>
      <span>clients</span><strong>{$mobileSignerStatus.connectionCount}</strong>
    </div>
    {#if $mobileSignerStatus.lastMessage}<p class="muted">{$mobileSignerStatus.lastMessage}</p>{/if}
    {#if $mobileSignerStatus.lastError}<p class="error">{$mobileSignerStatus.lastError}</p>{/if}
  </section>

  {#if pendingNip55}
    <section class="pending">
      <h2>android signer request</h2>
      <p class="muted">{pendingNip55.type} from another app</p>
      <code>{pendingNip55.content}</code>
      <div class="actions">
        <a class="primary link-button" href={`/app/mobile-signer/android?request=${encodeURIComponent(pendingNip55.requestId)}`}>review</a>
        <button class="ghost" type="button" on:click={rejectAndroidRequest}>reject</button>
      </div>
    </section>
  {/if}

  <section>
    <h2>paired clients</h2>
    {#if connections.length === 0}
      <p class="muted">no clients paired yet.</p>
    {:else}
      <ul class="connections">
        {#each connections as connection (connection.clientPubkey)}
          <li>
            <div>
              <strong>{connection.name || shortKey(connection.clientPubkey)}</strong>
              <span>{connection.relays.length} relay{connection.relays.length === 1 ? '' : 's'} · {connection.perms.length} permission{connection.perms.length === 1 ? '' : 's'}</span>
              <code>{connection.clientPubkey}</code>
            </div>
            <button class="tiny" type="button" on:click={() => removeConnection(connection.clientPubkey)}>remove</button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if status}<p class="ok">{status}</p>{/if}
  {#if error}<p class="error">{error}</p>{/if}
</div>

<style>
  .page { max-width: 760px; margin: 0 auto; padding: 36px 24px 72px; color: var(--ink-deep); }
  .back { color: var(--ink); font-size: 13px; text-decoration: none; }
  .back:hover { color: var(--coral); }
  h1 { font-family: 'Space Grotesk', Inter, sans-serif; font-size: 30px; margin: 16px 0 8px; letter-spacing: 0; }
  .lede, .muted { color: var(--ink); font-size: 14px; line-height: 1.6; }
  section { margin-top: 28px; }
  h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0;
    border-bottom: 1px solid var(--rule); padding-bottom: 6px; margin: 0 0 12px;
  }
  .entry-row { display: flex; gap: 8px; align-items: center; }
  input {
    min-width: 0; flex: 1; border: 1px solid var(--rule); border-radius: 6px;
    background: var(--surface); color: var(--ink-deep); padding: 9px 10px;
    font-family: 'Courier New', monospace; font-size: 13px;
  }
  input:focus { outline: 2px solid var(--coral-soft); border-color: var(--coral); }
  .primary, .ghost, .tiny, .link-button {
    font-family: inherit; font-size: 13px; cursor: pointer; text-decoration: none;
    border-radius: 999px; white-space: nowrap;
  }
  .primary, .link-button { background: var(--coral); color: var(--on-coral); border: 0; padding: 9px 16px; }
  .primary:disabled, .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  .ghost { background: transparent; color: var(--ink-deep); border: 1px solid var(--rule); padding: 8px 14px; }
  .tiny { background: transparent; color: var(--ink); border: 1px solid var(--rule); padding: 5px 10px; }
  .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
  .account {
    display: grid; gap: 4px; padding: 12px; background: var(--paper-warm);
    border: 1px solid var(--rule); border-radius: 8px;
  }
  code { font-family: 'Courier New', monospace; font-size: 12px; word-break: break-all; color: var(--ink-deep); }
  .status-grid {
    display: grid; grid-template-columns: minmax(120px, 1fr) auto; gap: 8px 16px;
    max-width: 360px; font-size: 14px;
  }
  .status-grid span { color: var(--ink); }
  .connections { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
  .connections li {
    display: flex; justify-content: space-between; gap: 12px; align-items: center;
    border: 1px solid var(--rule); border-radius: 8px; padding: 10px 12px;
  }
  .connections strong, .connections span { display: block; }
  .connections span { color: var(--ink); font-size: 12px; margin: 2px 0; }
  .scanner {
    width: 100%; max-width: 420px; aspect-ratio: 4 / 3; margin-top: 10px;
    border-radius: 8px; border: 1px solid var(--rule); object-fit: cover; background: #111;
  }
  .pending { border-left: 4px solid var(--coral); padding-left: 14px; }
  .ok { color: var(--archive); font-size: 13px; }
  .error {
    color: var(--coral-deep); background: var(--coral-soft); border-radius: 8px;
    padding: 9px 12px; font-size: 13px;
  }
  @media (max-width: 620px) {
    .entry-row { flex-direction: column; align-items: stretch; }
    .primary { align-self: flex-start; }
    .connections li { align-items: flex-start; flex-direction: column; }
  }
</style>
