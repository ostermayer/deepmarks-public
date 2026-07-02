<script lang="ts">
  import { page } from '$app/stores';
  import { onDestroy, onMount, tick } from 'svelte';
  import { nip19 } from 'nostr-tools';
  import { BadgeCheck, Shield, ThumbsUp } from 'lucide-svelte';
  import Avatar from '$lib/components/Avatar.svelte';
  import {
    clearMobileSignerAccount,
    loadMobileSignerAccount,
    saveMobileSignerNsec,
    type MobileSignerAccount,
  } from '$lib/mobile/signer-account';
  import {
    completePendingNip46Approval,
    getPendingNip46Approval,
    loadMobileSignerConnections,
    mobileSignerStatus,
    pairNostrConnect,
    refreshNativeForegroundSignerStatus,
    removeMobileSignerConnection,
    restartMobileSignerService,
    setNativeForegroundSignerEnabled,
    type Nip46TrustLevel,
    type PendingNip46Approval,
    type MobileSignerConnection,
  } from '$lib/mobile/nip46-service';
  import {
    getPendingNostrSignerRequest,
    listNostrSignerTrust,
    removeNostrSignerTrust,
    rejectNostrSignerRequest,
    setNostrSignerTrust,
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
  let pendingNip46: PendingNip46Approval | null = null;
  let lastPendingNip46Id = '';
  let selectedTrustLevel: Nip46TrustLevel = 'medium';
  let autoPairedConnectParam = '';
  let foregroundBusy = false;
  let foregroundApprovalBusy = false;
  let androidSignerPermissions: AndroidSignerPermission[] = [];

  const ANDROID_SIGNER_TRUST_PREFIX = 'deepmarks-android-signer-trust:v5:';

  interface AndroidSignerPermission {
    appId: string;
    appName: string;
    level: Nip46TrustLevel;
    updatedAt: string;
  }

  const trustOptions: Array<{
    level: Nip46TrustLevel;
    title: string;
    description: string;
    icon: typeof BadgeCheck;
  }> = [
    { level: 'full', title: 'Full Trust', description: 'Sign all requests from this app.', icon: BadgeCheck },
    { level: 'medium', title: 'Medium Trust', description: 'Auto-approve requested permissions.', icon: ThumbsUp },
    { level: 'low', title: 'Low Trust', description: 'Ask before each signing request.', icon: Shield },
  ];

  $: connectParam = $page.url.searchParams.get('connect') ?? '';
  $: npub = account ? nip19.npubEncode(account.pubkey) : '';
  $: pendingAccountNpub = pendingNip46?.accountPubkey ? nip19.npubEncode(pendingNip46.accountPubkey) : '';
  $: pendingAppName = pendingNip46?.clientName || 'Nostr app';
  $: nativeShell = typeof window !== 'undefined' ? Capacitor.isNativePlatform() : false;
  $: androidNativeShell = typeof window !== 'undefined' ? Capacitor.getPlatform() === 'android' : false;

  onMount(() => {
    void refresh();
    const timer = setInterval(() => {
      void refreshPendingNip55();
      void refreshPendingNip46();
      void refreshNativeForegroundSignerStatus();
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
    await refreshPendingNip46();
    androidSignerPermissions = await loadAndroidSignerPermissions();
  }

  async function refreshPendingNip55(): Promise<void> {
    pendingNip55 = await getPendingNostrSignerRequest();
  }

  async function refreshPendingNip46(): Promise<void> {
    const next = await getPendingNip46Approval();
    pendingNip46 = next;
    if (next && next.requestId !== lastPendingNip46Id) {
      lastPendingNip46Id = next.requestId;
      selectedTrustLevel = next.trustLevel === 'unset' ? 'medium' : next.trustLevel;
    }
    if (!next) lastPendingNip46Id = '';
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

  async function setForegroundSigner(enabled: boolean): Promise<void> {
    foregroundBusy = true;
    error = '';
    status = '';
    try {
      await setNativeForegroundSignerEnabled(enabled);
      status = enabled ? 'background signer enabled' : 'background signer stopped';
    } catch (e) {
      error = (e as Error).message;
    } finally {
      foregroundBusy = false;
    }
  }

  async function rejectAndroidRequest(): Promise<void> {
    if (!pendingNip55) return;
    await rejectNostrSignerRequest(pendingNip55.requestId);
    pendingNip55 = null;
    status = 'request rejected';
  }

  async function completeForegroundRequest(approved: boolean): Promise<void> {
    if (!pendingNip46) return;
    foregroundApprovalBusy = true;
    error = '';
    status = '';
    try {
      await completePendingNip46Approval({
        requestId: pendingNip46.requestId,
        approved,
        trustLevel: selectedTrustLevel,
      });
      status = approved ? 'signer request approved' : 'signer request rejected';
      pendingNip46 = null;
      connections = await loadMobileSignerConnections();
      await refreshNativeForegroundSignerStatus();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      foregroundApprovalBusy = false;
    }
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

  function trustLabel(level: Nip46TrustLevel | undefined): string {
    if (level === 'full') return 'full trust';
    if (level === 'medium') return 'medium trust';
    if (level === 'low') return 'low trust';
    return 'trust not set';
  }

  async function loadAndroidSignerPermissions(): Promise<AndroidSignerPermission[]> {
    const permissionsByApp = new Map<string, AndroidSignerPermission>();
    try {
      const nativePermissions = await listNostrSignerTrust();
      for (const item of nativePermissions) {
        const level = normalizeTrustLevel(item.level);
        if (!item.appId || !level) continue;
        permissionsByApp.set(item.appId, {
          appId: item.appId,
          appName: item.appName || item.requesterName || item.appId,
          level,
          updatedAt: item.updatedAt === undefined ? '' : String(item.updatedAt),
        });
      }
    } catch {
      // Fall back to local records below.
    }
    if (typeof localStorage !== 'undefined') {
      try {
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (!key?.startsWith(ANDROID_SIGNER_TRUST_PREFIX)) continue;
          const parsed = parseAndroidSignerPermission(key, localStorage.getItem(key));
          if (parsed && !permissionsByApp.has(parsed.appId)) permissionsByApp.set(parsed.appId, parsed);
        }
      } catch {
        // Ignore broken localStorage entries.
      }
    }
    return Array.from(permissionsByApp.values()).sort((a, b) => a.appName.localeCompare(b.appName));
  }

  function parseAndroidSignerPermission(key: string, value: string | null): AndroidSignerPermission | null {
    const appId = key.slice(ANDROID_SIGNER_TRUST_PREFIX.length);
    if (!appId) return null;
    const plainLevel = normalizeTrustLevel(value);
    if (plainLevel) {
      return { appId, appName: appId, level: plainLevel, updatedAt: '' };
    }
    try {
      const parsed = JSON.parse(value ?? '{}') as {
        level?: unknown;
        requesterName?: unknown;
        requesterPackage?: unknown;
        updatedAt?: unknown;
      };
      const level = normalizeTrustLevel(parsed.level);
      if (!level) return null;
      const name = typeof parsed.requesterName === 'string' && parsed.requesterName.trim()
        ? parsed.requesterName.trim()
        : appId;
      return {
        appId,
        appName: name,
        level,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      };
    } catch {
      return null;
    }
  }

  function normalizeTrustLevel(value: unknown): Nip46TrustLevel | null {
    return value === 'full' || value === 'medium' || value === 'low' ? value : null;
  }

  async function setAndroidSignerPermission(appId: string, level: Nip46TrustLevel): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    const key = ANDROID_SIGNER_TRUST_PREFIX + appId;
    const current = androidSignerPermissions.find((permission) => permission.appId === appId);
    await setNostrSignerTrust({
      appId,
      level: level as 'full' | 'medium' | 'low',
      requesterName: current?.appName === appId ? '' : current?.appName || '',
    });
    localStorage.setItem(key, JSON.stringify({
      level,
      requesterPackage: appId,
      requesterName: current?.appName === appId ? '' : current?.appName || '',
      updatedAt: new Date().toISOString(),
    }));
    androidSignerPermissions = await loadAndroidSignerPermissions();
    status = `${current?.appName || appId} set to ${trustLabel(level)}`;
  }

  async function revokeAndroidSignerPermission(appId: string): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    const current = androidSignerPermissions.find((permission) => permission.appId === appId);
    await removeNostrSignerTrust(appId);
    localStorage.removeItem(ANDROID_SIGNER_TRUST_PREFIX + appId);
    androidSignerPermissions = await loadAndroidSignerPermissions();
    status = `${current?.appName || appId} permission revoked`;
  }
</script>

<svelte:head><title>mobile signer — Deepmarks</title></svelte:head>

<div class="page">
  <a class="back" href="/app/settings">← settings</a>
  <h1>mobile signer</h1>
  <p class="lede">
    Pair this app with NIP-46 clients. Android can keep the signer available with a
    persistent notification; iOS signs while the app is open.
  </p>

  {#if pendingNip46}
    <section class="foreground-approval">
      <div class="request-app">
        {#if pendingNip46.clientImage}
          <img src={pendingNip46.clientImage} alt="" />
        {:else}
          <span>{pendingAppName.slice(0, 1).toUpperCase()}</span>
        {/if}
        <div>
          <h2>{pendingAppName}</h2>
          {#if pendingNip46.clientUrl}<p>{pendingNip46.clientUrl}</p>{/if}
          <code>{pendingNip46.clientPubkey}</code>
        </div>
      </div>

      <div class="approval-tabs" aria-label="foreground signer request">
        <span class:active={pendingNip46.method === 'connect'}>login</span>
        <span class:active={pendingNip46.method !== 'connect'}>permissions</span>
      </div>

      <div class="approval-account">
        <Avatar pubkey={pendingNip46.accountPubkey} size={40} label={pendingAccountNpub} />
        <div>
          <strong>Deepmarks signer</strong>
          <span>{pendingAccountNpub}</span>
        </div>
      </div>

      <div class="request-summary">
        <span>{pendingNip46.method === 'connect' ? 'requested access' : 'requested action'}</span>
        <strong>{pendingNip46.method === 'connect' ? 'Connect to this account' : pendingNip46.permission}</strong>
        {#if pendingNip46.eventKind !== undefined}
          <em>kind {pendingNip46.eventKind}</em>
        {/if}
        {#if pendingNip46.eventContent}
          <code>{pendingNip46.eventContent}</code>
        {/if}
      </div>

      <div class="trust-list">
        {#each trustOptions as option}
          <button
            type="button"
            class:selected={selectedTrustLevel === option.level}
            on:click={() => (selectedTrustLevel = option.level)}
          >
            <svelte:component this={option.icon} class="trust-icon" size={26} strokeWidth={1.8} />
            <span>
              <strong>{option.title}</strong>
              <em>{option.description}</em>
            </span>
          </button>
        {/each}
      </div>

      <div class="actions approval-actions">
        <button class="primary" type="button" disabled={foregroundApprovalBusy} on:click={() => completeForegroundRequest(true)}>
          {pendingNip46.method === 'connect' ? 'approve login' : 'approve request'}
        </button>
        <button class="ghost" type="button" disabled={foregroundApprovalBusy} on:click={() => completeForegroundRequest(false)}>
          reject
        </button>
      </div>
    </section>
  {/if}

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
      <span>NIP-46 service</span><strong>{$mobileSignerStatus.running ? 'listening' : 'stopped'}</strong>
      <span>relays</span><strong>{$mobileSignerStatus.relayCount}</strong>
      <span>paired NIP-46 clients</span><strong>{$mobileSignerStatus.connectionCount}</strong>
    </div>
    {#if $mobileSignerStatus.lastMessage}<p class="muted">{$mobileSignerStatus.lastMessage}</p>{/if}
    {#if $mobileSignerStatus.lastError}<p class="error">{$mobileSignerStatus.lastError}</p>{/if}
  </section>

  {#if nativeShell && $mobileSignerStatus.foregroundAvailable}
    <section>
      <h2>NIP-46 background signer</h2>
      <label class="toggle-row">
        <input
          type="checkbox"
          checked={$mobileSignerStatus.foregroundEnabled}
          disabled={!account || connections.length === 0 || foregroundBusy}
          on:change={(event) => setForegroundSigner((event.currentTarget as HTMLInputElement).checked)}
        />
        <span>
          <strong>keep NIP-46 signer running</strong>
          <em>For paired nostrconnect or bunker clients. Android signer apps like Amethyst use the separate foreground approval screen.</em>
        </span>
      </label>
      {#if !account}<p class="muted">add a mobile signer key first.</p>{/if}
      {#if account && connections.length === 0}<p class="muted">pair a NIP-46 client first; Amethyst's Android signer login does not use this service.</p>{/if}
    </section>
  {/if}

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

  {#if androidNativeShell}
    <section>
      <h2>android app permissions</h2>
      {#if androidSignerPermissions.length === 0}
        <p class="muted">no Android signer app permissions saved yet.</p>
      {:else}
        <ul class="app-permissions">
          {#each androidSignerPermissions as permission (permission.appId)}
            <li>
              <div>
                <strong>{permission.appName}</strong>
                <span>{permission.appId}</span>
                <em>{trustLabel(permission.level)}</em>
              </div>
              <div class="permission-actions" aria-label={`permissions for ${permission.appName}`}>
                {#each trustOptions as option}
                  <button
                    type="button"
                    class:selected={permission.level === option.level}
                    on:click={() => void setAndroidSignerPermission(permission.appId, option.level)}
                  >
                    {option.level}
                  </button>
                {/each}
                <button type="button" class="revoke" on:click={() => void revokeAndroidSignerPermission(permission.appId)}>
                  revoke
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
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
              <span>{connection.relays.length} relay{connection.relays.length === 1 ? '' : 's'} · {connection.perms.length} permission{connection.perms.length === 1 ? '' : 's'} · {trustLabel(connection.trustLevel)}</span>
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
  .foreground-approval {
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--surface);
    padding: 16px;
    box-shadow: 0 10px 30px var(--shadow);
  }
  .request-app {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 12px;
    align-items: center;
    text-align: left;
  }
  .request-app img,
  .request-app > span {
    width: 54px;
    height: 54px;
    border-radius: 50%;
    border: 1px solid var(--rule);
    background: var(--paper-warm);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    object-fit: cover;
    color: var(--coral);
    font: 700 24px 'Space Grotesk', Inter, sans-serif;
  }
  .request-app h2 {
    border: 0;
    color: var(--ink-deep);
    font-size: 22px;
    margin: 0;
    padding: 0;
    text-transform: none;
  }
  .request-app p {
    color: var(--ink);
    margin: 2px 0 3px;
    word-break: break-word;
  }
  .approval-tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    margin: 18px -16px 12px;
    border-bottom: 1px solid var(--rule);
  }
  .approval-tabs span {
    padding: 9px 16px;
    color: var(--ink);
    font-size: 12px;
    font-weight: 700;
    text-align: center;
    text-transform: uppercase;
  }
  .approval-tabs .active {
    color: var(--ink-deep);
    box-shadow: inset 0 -3px 0 var(--coral);
  }
  .approval-account {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    border: 1px solid var(--coral);
    border-radius: 8px;
    padding: 10px;
    background: var(--paper);
  }
  .approval-account strong,
  .approval-account span {
    display: block;
  }
  .approval-account span {
    color: var(--ink);
    font-size: 12px;
    word-break: break-all;
  }
  .request-summary {
    display: grid;
    gap: 4px;
    margin-top: 14px;
    padding: 10px 0 2px;
  }
  .request-summary span,
  .request-summary em {
    color: var(--ink);
    font-size: 12px;
    font-style: normal;
  }
  .request-summary strong {
    font-size: 15px;
  }
  .trust-list {
    display: grid;
    gap: 8px;
    margin-top: 12px;
  }
  .trust-list button {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    width: 100%;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--paper);
    color: var(--ink-deep);
    padding: 12px;
    text-align: left;
    cursor: pointer;
  }
  .trust-list button.selected {
    border-color: var(--coral);
    box-shadow: 0 0 0 2px var(--coral-soft);
  }
  :global(.trust-icon) {
    color: var(--coral);
  }
  .trust-list strong,
  .trust-list em {
    display: block;
  }
  .trust-list em {
    color: var(--ink);
    font-size: 12px;
    font-style: normal;
    line-height: 1.35;
    margin-top: 2px;
  }
  .approval-actions {
    justify-content: flex-end;
    margin-top: 14px;
  }
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
  .toggle-row {
    display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: start;
    border: 1px solid var(--rule); border-radius: 8px; padding: 12px; background: var(--surface);
  }
  .toggle-row input { width: 18px; height: 18px; margin-top: 2px; flex: none; min-width: 18px; }
  .toggle-row strong, .toggle-row em { display: block; }
  .toggle-row em { color: var(--ink); font-size: 12px; font-style: normal; line-height: 1.45; margin-top: 2px; }
  .connections { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
  .connections li,
  .app-permissions li {
    display: flex; justify-content: space-between; gap: 12px; align-items: center;
    border: 1px solid var(--rule); border-radius: 8px; padding: 10px 12px;
  }
  .connections strong,
  .connections span,
  .app-permissions strong,
  .app-permissions span,
  .app-permissions em {
    display: block;
  }
  .connections span,
  .app-permissions span,
  .app-permissions em {
    color: var(--ink);
    font-size: 12px;
    margin: 2px 0;
    font-style: normal;
  }
  .app-permissions { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
  .permission-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .permission-actions button {
    border: 1px solid var(--rule);
    border-radius: 999px;
    background: transparent;
    color: var(--ink);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    padding: 5px 9px;
  }
  .permission-actions button.selected {
    border-color: var(--coral);
    color: var(--coral-deep);
    background: var(--coral-soft);
  }
  .permission-actions .revoke {
    color: var(--coral-deep);
  }
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
    .approval-actions { justify-content: flex-start; }
    .connections li,
    .app-permissions li {
      align-items: flex-start;
      flex-direction: column;
    }
    .permission-actions { justify-content: flex-start; }
  }
</style>
