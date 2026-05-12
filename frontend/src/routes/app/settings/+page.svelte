<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { theme } from '$lib/stores/theme';
  import { session } from '$lib/stores/session';
  import type { UserSettings } from '$lib/stores/user-settings';
  import { userSettings } from '$lib/stores/user-settings';
  import { getLifetimeStatus } from '$lib/nostr/lifetime-status';
  import { getRelayList } from '$lib/nostr/relay-list';
  import { ensureRelayUrlsConnected } from '$lib/nostr/ndk';
  import { api, type AccountSettings } from '$lib/api/client';
  import { config } from '$lib/config';
  import { IS_APPLE_BUILD } from '$lib/build-flags';
  import ApiKeysSection from '$lib/components/ApiKeysSection.svelte';
  import UsernameSection from '$lib/components/UsernameSection.svelte';
  import DeleteAccountSection from '$lib/components/DeleteAccountSection.svelte';
  import LightningAddressSection from '$lib/components/LightningAddressSection.svelte';
  import NwcSection from '$lib/components/NwcSection.svelte';
  import ProfilePictureSection from '$lib/components/ProfilePictureSection.svelte';
  import PrivateKeySection from '$lib/components/PrivateKeySection.svelte';
  import ArchiveDownloadSection from '$lib/components/ArchiveDownloadSection.svelte';

  $: lifetimeStatus = $session.pubkey ? getLifetimeStatus($session.pubkey) : null;
  $: isLifetime = !!(lifetimeStatus && $lifetimeStatus);
  $: archiveDefaultEnabled = isLifetime && (
    $userSettings.archiveAllByDefault || !$userSettings.archiveDefaultManualOverride
  );

  // NIP-65 relay list (kind:10002) for the signed-in user. Displays the
  // relay preferences Deepmarks picked up via NDK's outbox model; stays
  // null if the user has never published one, in which case we fall
  // back to showing the default set.
  $: relayListStore = $session.pubkey ? getRelayList($session.pubkey) : null;
  $: userRelays = relayListStore ? $relayListStore : null;

  let newRelay = '';
  let newBlossom = '';
  let blossomError = '';
  let relayError = '';
  let syncStatus = '';
  let syncLoadedFor = '';
  let syncLoadingFor = '';
  let syncFailedFor = '';
  let settingsSyncReady = false;
  let autoImportedRelaySignature = '';
  $: nip65RelaysToImport = userRelays
    ? userRelays.relays
        .map((r) => relayEntryToSettings(r))
        .filter((r): r is NonNullable<ReturnType<typeof relayEntryToSettings>> => !!r)
        .filter((r) => !$userSettings.relays.some((existing) => existing.url === r.url))
    : [];
  // Profile name + bio + nip05 are intentionally NOT managed here —
  // purpose-built nostr clients (Damus, Primal, Amethyst, …) already
  // own that UX. We do surface:
  //   • lightning address — lets other users zap this curator profile
  //   • profile picture — the extension links here when the user taps
  //     their default avatar; sending them to a separate client just
  //     to set an avatar is bad UX

  function normalizeBlossomUrl(raw: string): string {
    const value = raw.trim();
    if (!value) throw new Error('enter a Blossom server URL');
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') throw new Error('use an https Blossom server URL');
    if (!parsed.hostname.includes('.') || parsed.hostname === 'localhost' || parsed.hostname.endsWith('.local')) {
      throw new Error('use a public Blossom server hostname');
    }
    return parsed.origin;
  }

  function normalizeRelayUrl(raw: string): string {
    const value = raw.trim().replace(/\/$/, '');
    if (!value) throw new Error('enter a relay URL');
    const parsed = new URL(value);
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
      throw new Error('use a wss:// relay URL');
    }
    if (!parsed.hostname.includes('.') || parsed.hostname === 'localhost' || parsed.hostname.endsWith('.local')) {
      throw new Error('use a public relay hostname');
    }
    return parsed.toString().replace(/\/$/, '');
  }

  onMount(() => {
    if ($session.pubkey && !$session.signer) syncStatus = 'connect signer to sync';
  });

  $: signerSyncKey = $session.pubkey && $session.signer
    ? `${$session.pubkey}:${$session.signer.kind}`
    : '';

  $: if (
    signerSyncKey &&
    syncLoadedFor !== signerSyncKey &&
    syncLoadingFor !== signerSyncKey &&
    syncFailedFor !== signerSyncKey &&
    $session.pubkey
  ) {
    syncLoadingFor = signerSyncKey;
    void loadSettingsSync($session.pubkey, signerSyncKey);
  }

  $: if ($session.pubkey && !$session.signer && !syncStatus) {
    syncStatus = 'connect signer to sync';
  }

  $: if (settingsSyncReady && userRelays && nip65RelaysToImport.length > 0) {
    const signature = `${userRelays.pubkey}:${userRelays.at}:${nip65RelaysToImport
      .map((r) => `${r.url}:${r.read ? 'r' : ''}${r.write ? 'w' : ''}`)
      .join('|')}`;
    if (signature !== autoImportedRelaySignature) {
      autoImportedRelaySignature = signature;
      void patchSyncedSettings({
        relays: mergeRelays($userSettings.relays, nip65RelaysToImport),
      });
    }
  }

  async function loadSettingsSync(pubkey: string, syncKey = signerSyncKey): Promise<void> {
    void pubkey;
    if (!$session.signer) {
      syncStatus = 'connect signer to sync';
      if (syncLoadingFor === syncKey) syncLoadingFor = '';
      return;
    }
    syncStatus = $session.signer.kind === 'nip07'
      ? 'syncing settings — approve in extension if prompted'
      : 'syncing settings…';
    try {
      const remote = await api.account.getSettings();
      if (remote.updatedAt >= $userSettings.syncedAt) {
        userSettings.update((current) => ({ ...current, ...remote, syncedAt: remote.updatedAt }));
        connectSettingsRelays(remote.relays);
      } else {
        const saved = await api.account.putSettings(toAccountSettings($userSettings));
        userSettings.update((current) => ({ ...current, ...saved, syncedAt: saved.updatedAt }));
        connectSettingsRelays(saved.relays);
      }
      syncStatus = 'settings synced';
      syncLoadedFor = syncKey;
      syncFailedFor = '';
      settingsSyncReady = true;
    } catch (e) {
      syncFailedFor = syncKey;
      syncStatus = `local settings active${(e as Error).message ? ' — connect signer to sync' : ''}`;
    } finally {
      if (syncLoadingFor === syncKey) syncLoadingFor = '';
    }
  }

  async function updateSyncedSettings(next: UserSettings): Promise<void> {
    const optimistic = {
      ...next,
      syncedAt: Math.max(next.syncedAt, Math.floor(Date.now() / 1000)),
    };
    userSettings.set(optimistic);
    connectSettingsRelays(optimistic.relays);
    if (!$session.pubkey || !$session.signer) {
      syncStatus = 'saved locally; connect signer to sync';
      return;
    }
    syncStatus = $session.signer.kind === 'nip07'
      ? 'saving settings — approve in extension if prompted'
      : 'saving settings…';
    try {
      const saved = await api.account.putSettings(toAccountSettings(optimistic));
      userSettings.update((current) => ({ ...current, ...saved, syncedAt: saved.updatedAt }));
      connectSettingsRelays(saved.relays);
      syncStatus = 'settings synced';
      if (signerSyncKey) syncLoadedFor = signerSyncKey;
      syncFailedFor = '';
      settingsSyncReady = true;
    } catch (e) {
      syncStatus = `saved locally; sync failed: ${(e as Error).message}`;
    }
  }

  function connectSettingsRelays(relays: UserSettings['relays']): void {
    ensureRelayUrlsConnected(
      relays.filter((r) => r.read || r.write).map((r) => r.url),
    );
  }

  async function patchSyncedSettings(patch: Partial<UserSettings>): Promise<void> {
    await updateSyncedSettings({ ...$userSettings, ...patch });
  }

  function toAccountSettings(settings: UserSettings): Omit<AccountSettings, 'schemaVersion' | 'updatedAt'> {
    return {
      relays: settings.relays,
      defaultTags: settings.defaultTags,
      defaultVisibility: settings.defaultVisibility,
      archiveAllByDefault: settings.archiveAllByDefault,
      archiveDefaultManualOverride: settings.archiveDefaultManualOverride,
      backupBlossomServers: settings.backupBlossomServers,
    };
  }

  function addRelay() {
    relayError = '';
    try {
      const url = normalizeRelayUrl(newRelay);
      if ($userSettings.relays.some((r) => r.url === url)) {
        newRelay = '';
        return;
      }
      newRelay = '';
      void patchSyncedSettings({
        relays: [...$userSettings.relays, { url, read: true, write: true }],
      });
    } catch (e) {
      relayError = (e as Error).message;
    }
  }

  function updateRelay(url: string, patch: { read?: boolean; write?: boolean }) {
    const relays = $userSettings.relays.map((r) => (
      r.url === url ? { ...r, ...patch } : r
    ));
    void patchSyncedSettings({ relays });
  }

  function removeRelay(url: string) {
    const relays = $userSettings.relays.filter((r) => r.url !== url);
    void patchSyncedSettings({ relays });
  }

  function relayEntryToSettings(entry: { url: string; mode: 'read' | 'write' | 'both' }): UserSettings['relays'][number] | null {
    try {
      const url = normalizeRelayUrl(entry.url);
      return {
        url,
        read: entry.mode !== 'write',
        write: entry.mode !== 'read',
      };
    } catch {
      return null;
    }
  }

  function mergeRelays(
    current: UserSettings['relays'],
    incoming: UserSettings['relays'],
  ): UserSettings['relays'] {
    const byUrl = new Map(current.map((r) => [r.url, r]));
    for (const relay of incoming) {
      if (!byUrl.has(relay.url)) byUrl.set(relay.url, relay);
    }
    return [...byUrl.values()];
  }

  function addBlossomServer() {
    blossomError = '';
    try {
      const url = normalizeBlossomUrl(newBlossom);
      if ($userSettings.backupBlossomServers.includes(url)) {
        newBlossom = '';
        return;
      }
      if ($userSettings.backupBlossomServers.length >= 8) {
        throw new Error('up to 8 backup Blossom servers are supported');
      }
      void patchSyncedSettings({
        backupBlossomServers: [...$userSettings.backupBlossomServers, url],
      });
      newBlossom = '';
    } catch (e) {
      blossomError = (e as Error).message;
    }
  }

  function removeBlossomServer(url: string) {
    void patchSyncedSettings({
      backupBlossomServers: $userSettings.backupBlossomServers.filter((v) => v !== url),
    });
  }
</script>

<svelte:head><title>settings — Deepmarks</title></svelte:head>

<div class="page">
  <h1>settings</h1>
  <p class="sync-status">{syncStatus || 'changes autosave'}</p>

  <PrivateKeySection />

  <section>
    <h2>plan</h2>
    {#if isLifetime}
      <p class="muted">lifetime ✓ — archiving, API keys, and short handles are unlocked.</p>
    {:else if IS_APPLE_BUILD}
      <p class="muted">
        free account — bookmarking works in the app. Lifetime-only features unlock
        automatically here after the identity is upgraded on the website.
      </p>
    {:else}
      <p class="muted">
        free — save private and public bookmarks. lifetime is a one-time
        {config.lifetimePriceSats.toLocaleString('en-US')} sats and unlocks page archiving.
      </p>
      <a href="/app/upgrade" class="upgrade-cta">upgrade to lifetime →</a>
    {/if}
  </section>

  <ProfilePictureSection />

  <LightningAddressSection />

  <NwcSection />

  <section>
    <h2>mobile signer</h2>
    <p class="muted">
      Use the iOS or Android app as a Nostr remote signer for websites and other clients.
      Pair it with a nostrconnect link or QR code.
    </p>
    <a class="upgrade-cta neutral" href="/app/mobile-signer">open mobile signer</a>
  </section>

  <UsernameSection {isLifetime} />

  <section>
    <h2>theme</h2>
    <div class="theme-row">
      <button class:active={$theme === 'light'} on:click={() => theme.set('light')}>light</button>
      <button class:active={$theme === 'dark'} on:click={() => theme.set('dark')}>dark</button>
      <button class:active={$theme === 'auto'} on:click={() => theme.set('auto')}>follow system</button>
    </div>
  </section>

  <section>
    <h2>relays</h2>
    <p class="muted">
      This is the active Deepmarks relay list. Every change autosaves and syncs to the web app,
      mobile app, and browser extensions. Your NIP-65 list from other Nostr apps is automatically
      merged here when found.
    </p>
    <ul class="relay-list">
      {#each $userSettings.relays as r (r.url)}
        <li>
          <code>{r.url}</code>
          <span class="relay-controls">
            <label><input type="checkbox" checked={r.read} on:change={(e) => updateRelay(r.url, { read: e.currentTarget.checked })} /> read</label>
            <label><input type="checkbox" checked={r.write} on:change={(e) => updateRelay(r.url, { write: e.currentTarget.checked })} /> write</label>
            <button class="tiny" type="button" on:click={() => removeRelay(r.url)}>remove</button>
          </span>
        </li>
      {/each}
    </ul>
    <div class="add-relay">
      <input
        type="text"
        placeholder="wss://your-relay.example"
        bind:value={newRelay}
        on:keydown={(e) => e.key === 'Enter' && addRelay()}
      />
      <button class="primary" type="button" on:click={addRelay}>add relay</button>
    </div>
    {#if relayError}<p class="status-error">{relayError}</p>{/if}
    {#if userRelays && userRelays.relays.length > 0}
      <p class="muted">
        NIP-65 relay list found and imported, signed <code>{new Date(userRelays.at * 1000).toLocaleDateString()}</code>.
      </p>
      <ul class="relay-list compact-list">
        {#each userRelays.relays as r (r.url)}
          <li>
            <code>{r.url}</code>
            {#if r.mode !== 'both'}<span class="badge mode-{r.mode}">{r.mode}</span>{/if}
          </li>
        {/each}
      </ul>
    {:else if relayListStore && userRelays === null}
      <p class="muted">looking for your NIP-65 list on connected relays…</p>
      <ul class="relay-list">
        <li><code>{config.deepmarksRelay}</code> <span class="badge">deepmarks</span></li>
        {#each config.defaultRelays as r}
          <li><code>{r}</code></li>
        {/each}
      </ul>
    {:else}
      <p class="muted">default set — sign in to load your NIP-65 list.</p>
      <ul class="relay-list">
        <li><code>{config.deepmarksRelay}</code> <span class="badge">deepmarks</span></li>
        {#each config.defaultRelays as r}
          <li><code>{r}</code></li>
        {/each}
      </ul>
    {/if}
  </section>

  <section>
    <h2>new bookmark defaults</h2>
    <p class="muted">
      These defaults apply when saving from the web app, mobile app, and browser extensions.
    </p>
    <div class="visibility-row">
      <button
        type="button"
        class:active={$userSettings.defaultVisibility === 'private'}
        on:click={() => void patchSyncedSettings({ defaultVisibility: 'private' })}
      >private</button>
      <button
        type="button"
        class:active={$userSettings.defaultVisibility === 'public'}
        on:click={() => void patchSyncedSettings({ defaultVisibility: 'public' })}
      >public</button>
    </div>
  </section>

  <section>
    <h2>site archive storage</h2>
    <p class="muted">
      Lifetime archives are stored on Deepmarks and mirrored to Primal by default. Add your own
      paid or trusted Blossom servers here for extra copies.
    </p>
    {#if !isLifetime}
      <p class="muted">
        Archiving is a lifetime feature. Once this identity is lifetime,
        archive defaults unlock here automatically.
      </p>
      {#if !IS_APPLE_BUILD}
        <a href="/app/upgrade" class="upgrade-cta">upgrade to lifetime →</a>
      {/if}
    {:else}
      <label class="toggle">
        <input
          type="checkbox"
          checked={archiveDefaultEnabled}
          on:change={(e) =>
            void patchSyncedSettings({
              archiveAllByDefault: e.currentTarget.checked,
              archiveDefaultManualOverride: true,
            })}
        />
        <span>
          archive every bookmark by default
          <small>— included with lifetime membership</small>
        </span>
      </label>
      <div class="blossom-list">
        {#if $userSettings.backupBlossomServers.length === 0}
          <p class="muted compact">no personal backup servers yet.</p>
        {:else}
          <ul class="relay-list">
            {#each $userSettings.backupBlossomServers as url}
              <li>
                <code>{url}</code>
                <button class="tiny" type="button" on:click={() => removeBlossomServer(url)}>remove</button>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="add-relay">
          <input
            type="text"
            placeholder="https://blossom.example.com"
            bind:value={newBlossom}
            on:keydown={(e) => e.key === 'Enter' && addBlossomServer()}
          />
          <button class="primary" type="button" on:click={addBlossomServer}>add backup</button>
        </div>
        {#if blossomError}<p class="status-error">{blossomError}</p>{/if}
      </div>
    {/if}
  </section>

  <ArchiveDownloadSection />

  <ApiKeysSection />

  <section>
    <h2>sign out</h2>
    <p class="muted">sign out of this browser — your nostr data stays on the relays.</p>
    <button
      type="button"
      class="ghost"
      on:click={() => { session.logout(); void goto('/'); }}
    >sign out</button>
  </section>

  <DeleteAccountSection />
</div>

<style>
  .page {
    max-width: 720px;
    margin: 0 auto;
    padding: 36px 24px 60px;
    color: var(--ink-deep);
    font-size: 14px;
  }
  h1 { font-family: 'Space Grotesk', Inter, sans-serif; font-size: 30px; color: var(--ink-deep); letter-spacing: 0; margin: 0 0 8px; }
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
  code { font-family: 'Courier New', monospace; font-size: 12px; color: var(--ink-deep); word-break: break-all; }
  .theme-row { display: flex; gap: 8px; }
  .theme-row button,
  .visibility-row button { background: var(--surface); border: 1px solid var(--rule); color: var(--ink); padding: 6px 14px; border-radius: 100px; cursor: pointer; font-size: 13px; }
  .theme-row button.active,
  .visibility-row button.active { border-color: var(--coral); color: var(--coral); }
  .visibility-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .muted { color: var(--ink-deep); font-size: 14px; line-height: 1.6; }
  .upgrade-cta {
    display: inline-block; margin-top: 8px;
    background: var(--coral); color: var(--on-coral) !important;
    padding: 8px 16px; border-radius: 100px;
    font-size: 14px; font-weight: 500; text-decoration: none;
  }
  .upgrade-cta:hover { background: var(--coral-deep); text-decoration: none; }
  .upgrade-cta.neutral { background: var(--surface); color: var(--ink-deep) !important; border: 1px solid var(--rule); }
  .upgrade-cta.neutral:hover { border-color: var(--coral); color: var(--coral-deep) !important; background: var(--surface); }
  .relay-list { list-style: none; padding: 0; margin: 0 0 12px; }
  .relay-list li { padding: 6px 0; border-bottom: 1px dashed var(--rule); display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-deep); }
  .compact-list { margin-top: 8px; opacity: 0.85; }
  .relay-controls { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  .relay-controls label { display: inline-flex; align-items: center; gap: 3px; color: var(--ink); font-size: 12px; }
  .sync-status { color: var(--ink); font-size: 13px; margin: -2px 0 10px; }
  .badge { background: var(--coral-soft); color: var(--coral-deep); padding: 1px 8px; border-radius: 10px; font-size: 10px; text-transform: uppercase; letter-spacing: 0; font-weight: 600; }
  .badge.mode-read { background: var(--paper-warm); color: var(--ink-deep); }
  .badge.mode-write { background: var(--paper-warm); color: var(--ink-deep); }
  .add-relay { display: flex; gap: 8px; }
  .add-relay input { flex: 1; padding: 8px 10px; border: 1px solid var(--rule); border-radius: 6px; background: var(--surface); color: var(--ink-deep); font-family: 'Courier New', monospace; font-size: 13px; }
  .primary { background: var(--coral); color: var(--on-coral); border: 0; padding: 8px 16px; border-radius: 100px; cursor: pointer; font-size: 14px; font-family: inherit; }
  .primary:hover:not(:disabled) { background: var(--coral-deep); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .blossom-list { margin-top: 14px; }
  .compact { margin: 0 0 10px; }
  .tiny { background: transparent; border: 1px solid var(--rule); color: var(--ink); padding: 4px 8px; border-radius: 999px; cursor: pointer; font-size: 12px; }
  .tiny:hover { border-color: var(--coral); color: var(--coral-deep); }
  .tiny:disabled { opacity: 0.55; cursor: default; }
  .status-error { color: var(--coral-deep); background: var(--coral-soft); border-radius: 6px; padding: 8px 10px; font-size: 13px; margin: 8px 0 0; }
  .ghost { background: transparent; border: 1px solid var(--rule); color: var(--ink-deep); padding: 8px 16px; border-radius: 100px; cursor: pointer; font-size: 14px; }
  .ghost:hover { border-color: var(--coral); color: var(--coral-deep); }
  .toggle { display: flex; align-items: flex-start; gap: 10px; margin-top: 12px; cursor: pointer; font-size: 14px; color: var(--ink-deep); }
  .toggle input { margin-top: 3px; flex-shrink: 0; }
  .toggle small { display: block; color: var(--ink); font-size: 12px; margin-top: 2px; }
</style>
