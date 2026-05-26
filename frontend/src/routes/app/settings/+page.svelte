<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { theme } from '$lib/stores/theme';
  import { session } from '$lib/stores/session';
  import type { ThemePreference, UserSettings } from '$lib/stores/user-settings';
  import {
    mergeSyncedAccountSettings,
    pendingLocalSettingsShouldWin,
    toSyncedAccountSettings,
    userSettings,
  } from '$lib/stores/user-settings';
  import { getLifetimeStatus } from '$lib/nostr/lifetime-status';
  import { ensureRelayUrlsConnected } from '$lib/nostr/ndk';
  import { api } from '$lib/api/client';
  import { config } from '$lib/config';
  import { IS_APPLE_BUILD } from '$lib/build-flags';
  import ApiKeysSection from '$lib/components/ApiKeysSection.svelte';
  import UsernameSection from '$lib/components/UsernameSection.svelte';
  import DeleteAccountSection from '$lib/components/DeleteAccountSection.svelte';
  import LightningAddressSection from '$lib/components/LightningAddressSection.svelte';
  import NwcSection from '$lib/components/NwcSection.svelte';
  import ProfilePictureSection from '$lib/components/ProfilePictureSection.svelte';
  import PrivateKeySection from '$lib/components/PrivateKeySection.svelte';
  import MobileAppLockSection from '$lib/components/MobileAppLockSection.svelte';
  import ArchiveDownloadSection from '$lib/components/ArchiveDownloadSection.svelte';
  import PushNotificationsSection from '$lib/components/PushNotificationsSection.svelte';
  import RepublishToRelaySection from '$lib/components/RepublishToRelaySection.svelte';
  import AddOnsSection from '$lib/components/AddOnsSection.svelte';
  import { EXTENSION_LINKS } from '$lib/extension-links';
  import { suppressDeepmarksAutoLoginOnce } from '$lib/nostr/extension-autologin';
  import { isNativeShell } from '$lib/native/runtime';

  $: lifetimeStatus = $session.pubkey ? getLifetimeStatus($session.pubkey) : null;
  $: isLifetime = !!(lifetimeStatus && $lifetimeStatus);
  $: archiveDefaultEnabled = isLifetime && (
    $userSettings.archiveAllByDefault || !$userSettings.archiveDefaultManualOverride
  );

  let newRelay = '';
  let newBlossom = '';
  let blossomError = '';
  let relayError = '';

  let nip65PublishStatus = '';
  let archiveDefaultNotice = '';

  // Re-sync state is owned by RepublishToRelaySection.svelte now.

  let syncStatus = '';
  let syncLoadedFor = '';
  let syncLoadingFor = '';
  let syncFailedFor = '';
  let settingsSyncReady = false;
  let nativeShell = isNativeShell();
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

  // The previous build auto-imported NIP-65 relays into the active
  // list on every settings change, which silently resurrected relays
  // users had explicitly removed. The active list is now the only
  // relay list users see; we mirror it out to NIP-65 (kind:10002) in
  // updateSyncedSettings instead so the broadcast stays in sync
  // without ever pulling in surprises.

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
      const local = $userSettings;
      if (pendingLocalSettingsShouldWin(local, remote)) {
        const saved = await api.account.putSettings(toSyncedAccountSettings(local));
        userSettings.update((current) => mergeSyncedAccountSettings(current, saved));
        theme.set(saved.theme);
        connectSettingsRelays(saved.relays);
      } else {
        userSettings.update((current) => mergeSyncedAccountSettings(current, remote));
        theme.set(remote.theme);
        connectSettingsRelays(remote.relays);
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
      pendingSync: true,
      syncedAt: Math.max(next.syncedAt, Math.floor(Date.now() / 1000)),
    };
    userSettings.set(optimistic);
    theme.set(optimistic.theme);
    connectSettingsRelays(optimistic.relays);
    if (!$session.pubkey || !$session.signer) {
      syncStatus = 'saved locally; connect signer to sync';
      return;
    }
    syncStatus = $session.signer.kind === 'nip07'
      ? 'saving settings — approve in extension if prompted'
      : 'saving settings…';
    try {
      const saved = await api.account.putSettings(toSyncedAccountSettings(optimistic));
      userSettings.update((current) => mergeSyncedAccountSettings(current, saved));
      theme.set(saved.theme);
      connectSettingsRelays(saved.relays);
      syncStatus = 'settings synced';
      if (signerSyncKey) syncLoadedFor = signerSyncKey;
      syncFailedFor = '';
      settingsSyncReady = true;
      // Whenever the active relay list changes we silently mirror it
      // to the public Nostr relay list (kind:10002) so other Nostr
      // clients see the same set the user picked here. Debounced
      // below to avoid one publish per checkbox toggle.
      scheduleRelayBroadcast(saved.relays);
    } catch (e) {
      syncStatus = `saved locally; sync failed: ${(e as Error).message}`;
    }
  }

  let relayBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRelayBroadcast(relays: UserSettings['relays']): void {
    if (!$session.pubkey || !$session.signer) return;
    if (relayBroadcastTimer) clearTimeout(relayBroadcastTimer);
    relayBroadcastTimer = setTimeout(() => {
      relayBroadcastTimer = null;
      if (!$session.pubkey) return;
      const pubkey = $session.pubkey;
      void import('$lib/nostr/relay-list').then(({ publishRelayList }) => (
        publishRelayList(pubkey, relays)
      )).catch(() => { /* best-effort, retried via durable queue */ });
    }, 1_500);
  }

  function connectSettingsRelays(relays: UserSettings['relays']): void {
    ensureRelayUrlsConnected(
      relays.filter((r) => r.read || r.write).map((r) => r.url),
    );
  }

  async function patchSyncedSettings(patch: Partial<UserSettings>): Promise<void> {
    await updateSyncedSettings({ ...$userSettings, ...patch });
  }

  async function onArchiveDefaultChange(event: Event): Promise<void> {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    archiveDefaultNotice = '';
    if (isLifetime) {
      await patchSyncedSettings({
        archiveAllByDefault: checked,
        archiveDefaultManualOverride: true,
      });
      return;
    }
    if (!checked) return;
    if (IS_APPLE_BUILD) {
      archiveDefaultNotice = 'Archive all new bookmarks is for lifetime members. Eligible accounts unlock it automatically when signed in.';
      return;
    }
    void goto('/app/upgrade');
  }

  function setThemePreference(next: ThemePreference): void {
    void patchSyncedSettings({ theme: next });
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

  {#if nativeShell}
    <MobileAppLockSection />

    <section class="settings-band">
      <h2>mobile signer</h2>
      <p class="muted">
        Pair this device with NIP-46 clients. It only signs while the mobile
        app is open, and the key stays in this device's secure store.
      </p>
      <a class="upgrade-cta neutral" href="/app/mobile-signer">open mobile signer</a>
    </section>
  {/if}

  <section class="settings-band">
    <h2>plan</h2>
    {#if isLifetime}
      <p class="muted">lifetime ✓ — archiving, API keys, and short handles are unlocked.</p>
    {:else if IS_APPLE_BUILD}
      <p class="muted">
        free account — bookmarking works in the app. Lifetime membership unlocks
        automatic archives for the same npub, but purchases are not available in
        this iOS build.
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

  <UsernameSection {isLifetime} />

  <section class="settings-band">
    <h2>theme</h2>
    <div class="theme-row">
      <button class:active={$theme === 'light'} on:click={() => setThemePreference('light')}>light</button>
      <button class:active={$theme === 'dark'} on:click={() => setThemePreference('dark')}>dark</button>
      <button class:active={$theme === 'auto'} on:click={() => setThemePreference('auto')}>follow system</button>
    </div>
  </section>

  <section class="settings-band">
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
    <label class="toggle">
      <input
        type="checkbox"
        checked={$userSettings.defaultTags.includes('toread')}
        on:change={(e) => {
          const wanted = e.currentTarget.checked;
          const next = $userSettings.defaultTags.filter((t) => t !== 'toread');
          if (wanted) next.push('toread');
          void patchSyncedSettings({ defaultTags: next });
        }}
      />
      <span>mark new bookmarks as read later by default</span>
    </label>
    <label class="toggle">
      <input
        type="checkbox"
        checked={archiveDefaultEnabled}
        on:change={(e) => void onArchiveDefaultChange(e)}
      />
      <span>archive all new bookmarks</span>
    </label>
    {#if !isLifetime}
      <p class="muted compact">
        {IS_APPLE_BUILD
          ? 'Lifetime members can automatically archive every new bookmark.'
          : 'Turn this on to upgrade to lifetime and enable automatic archives.'}
      </p>
      {#if archiveDefaultNotice}<p class="status-error">{archiveDefaultNotice}</p>{/if}
    {/if}
  </section>

  <PushNotificationsSection />

  <RepublishToRelaySection />

  <ArchiveDownloadSection />

  <AddOnsSection />

  <NwcSection />

  <details class="advanced">
    <summary>advanced</summary>
    <p class="muted">
      These are the storage + interop settings that power Deepmarks under the hood. You almost
      certainly don't need to touch them — the defaults Just Work for everyone.
    </p>
    <section>
      <h2>storage</h2>
      <p class="muted">
        Deepmarks reads and writes your bookmarks through these servers. Changes autosave and
        sync across the web app, mobile app, and browser extensions.
      </p>
      {#if !settingsSyncReady && !!$session.pubkey}
        <p class="muted">loading the latest list from the server…</p>
      {:else}
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
      {/if}
      <div class="add-relay">
        <input
          type="text"
          placeholder="wss://your-server.example"
          bind:value={newRelay}
          on:keydown={(e) => e.key === 'Enter' && addRelay()}
        />
        <button class="primary" type="button" on:click={addRelay}>add</button>
      </div>
      {#if relayError}<p class="status-error">{relayError}</p>{/if}
      {#if nip65PublishStatus}<p class="muted">{nip65PublishStatus}</p>{/if}
    </section>

    {#if isLifetime}
      <section>
        <h2>extra archive copies</h2>
        <p class="muted">
          Archives are stored on Deepmarks and mirrored to Primal by default. Add your own
          paid or trusted Blossom servers for extra copies.
        </p>
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
      </section>
    {/if}

    <!-- The legacy "re-sync private / re-sync public" two-button
         flow that used to live here has been promoted out of the
         advanced section to a top-level "republish to deepmarks
         relay" section above (RepublishToRelaySection). One button,
         runs both halves, surfaces the pending-publish queue depth. -->

    <section>
      <h2>browser extensions</h2>
      <p class="muted">
        Use the same Deepmarks identity from desktop browsers. The extension can save pages
        and sign in to Deepmarks on any computer.
      </p>
      <div class="extension-links">
        <a href={EXTENSION_LINKS.chrome} target="_blank" rel="noreferrer">Chrome Web Store</a>
        <a href={EXTENSION_LINKS.firefox} target="_blank" rel="noreferrer">Firefox Add-ons</a>
      </div>
    </section>

    <ApiKeysSection />
  </details>

  <section class="settings-band signout-band">
    <h2>sign out</h2>
    <p class="muted">sign out of this {nativeShell ? 'device' : 'browser'} — your bookmarks stay safe; just sign back in to access them.</p>
    <button
      type="button"
      class="ghost"
      on:click={async () => {
        suppressDeepmarksAutoLoginOnce();
        await session.logout().catch(() => { /* tolerable */ });
        void goto('/', { replaceState: true });
      }}
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
  .settings-band,
  .page :global(.settings-band) {
    --settings-accent: var(--link);
    --settings-tint: var(--paper-warm);
    margin-top: 28px;
    padding: 16px 18px 18px;
    border-left: 4px solid var(--settings-accent);
    border-top: 1px solid var(--rule);
    border-right: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
    border-radius: 6px;
    background: linear-gradient(90deg, var(--settings-tint) 0, var(--surface) 72%);
  }
  .page > .settings-band:nth-of-type(4n + 1),
  .page > :global(.settings-band:nth-of-type(4n + 1)) {
    --settings-accent: var(--coral);
    --settings-tint: var(--save-tint);
  }
  .page > .settings-band:nth-of-type(4n + 2),
  .page > :global(.settings-band:nth-of-type(4n + 2)) {
    --settings-accent: var(--archive);
    --settings-tint: var(--archive-soft);
  }
  .page > .settings-band:nth-of-type(4n + 3),
  .page > :global(.settings-band:nth-of-type(4n + 3)) {
    --settings-accent: var(--zap);
    --settings-tint: var(--zap-soft);
  }
  .signout-band {
    --settings-accent: var(--zap);
    --settings-tint: color-mix(in srgb, var(--zap) 10%, var(--surface));
  }
  .signout-band .muted {
    color: var(--ink);
  }
  .signout-band .ghost {
    background: var(--surface);
    color: var(--ink-deep) !important;
  }
  .signout-band .ghost:hover {
    border-color: var(--zap);
    color: var(--zap) !important;
  }
  .settings-band h2,
  .page :global(.settings-band h2),
  .advanced section h2 {
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
  .extension-links {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }
  .extension-links a {
    display: inline-block;
    background: var(--surface);
    color: var(--ink-deep) !important;
    border: 1px solid var(--rule);
    border-radius: 100px;
    padding: 8px 16px;
    font-size: 14px;
    font-weight: 500;
    text-decoration: none;
  }
  .extension-links a:hover {
    border-color: var(--coral);
    color: var(--coral-deep) !important;
    text-decoration: none;
  }
  .relay-list { list-style: none; padding: 0; margin: 0 0 12px; }
  .relay-list li {
    padding: 8px 0;
    border-bottom: 1px dashed var(--rule);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    font-size: 13px;
    color: var(--ink-deep);
  }
  .relay-list li code {
    flex: 1 1 100%;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .relay-controls { display: inline-flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .relay-controls label { display: inline-flex; align-items: center; gap: 4px; color: var(--ink); font-size: 12px; }
  .sync-status { color: var(--ink); font-size: 13px; margin: -2px 0 10px; }
  .add-relay { display: flex; gap: 8px; }
  @media (min-width: 720px) {
    /* On wider screens keep the URL inline with controls instead of
       forcing it onto its own row. Mobile keeps the two-line wrap so
       long relay URLs don't squish the checkboxes. */
    .relay-list li {
      flex-wrap: nowrap;
      justify-content: space-between;
    }
    .relay-list li code {
      flex: 1 1 auto;
    }
  }
  .add-relay input { flex: 1; padding: 8px 10px; border: 1px solid var(--rule); border-radius: 6px; background: var(--surface); color: var(--ink-deep); font-family: 'Courier New', monospace; font-size: 13px; }
  .primary { background: var(--coral); color: var(--on-coral); border: 0; padding: 8px 16px; border-radius: 100px; cursor: pointer; font-size: 14px; font-family: inherit; }
  .primary:hover:not(:disabled) { background: var(--coral-deep); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .blossom-list { margin-top: 14px; }
  .compact { margin: 0 0 10px; }
  .advanced {
    margin-top: 32px;
    padding: 14px 16px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--paper-warm);
  }
  .advanced > summary {
    cursor: pointer;
    font-weight: 600;
    color: var(--ink-deep);
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .advanced > summary::marker { color: var(--muted); }
  .advanced > p:first-of-type { margin-top: 12px; }
  .advanced > section { margin-top: 20px; }
  .advanced > section:first-of-type { margin-top: 12px; }
  .tiny { background: transparent; border: 1px solid var(--rule); color: var(--ink); padding: 4px 8px; border-radius: 999px; cursor: pointer; font-size: 12px; }
  .tiny:hover { border-color: var(--coral); color: var(--coral-deep); }
  .tiny:disabled { opacity: 0.55; cursor: default; }
  .status-error { color: var(--coral-deep); background: var(--coral-soft); border-radius: 6px; padding: 8px 10px; font-size: 13px; margin: 8px 0 0; }
  .ghost { background: transparent; border: 1px solid var(--rule); color: var(--ink-deep); padding: 8px 16px; border-radius: 100px; cursor: pointer; font-size: 14px; }
  .ghost:hover { border-color: var(--coral); color: var(--coral-deep); }
  .toggle { display: flex; align-items: flex-start; gap: 10px; margin-top: 12px; cursor: pointer; font-size: 14px; color: var(--ink-deep); }
  .toggle input { margin-top: 3px; flex-shrink: 0; }
  @media (max-width: 640px) {
    .page {
      max-width: none;
      padding: 24px 12px 120px;
    }
    .settings-band,
    .page :global(.settings-band) {
      margin-top: 22px;
      padding: 14px 14px 16px;
      border-left-width: 3px;
      border-radius: 5px;
    }
    .advanced {
      margin-top: 22px;
      padding: 12px;
    }
    .theme-row {
      flex-wrap: wrap;
    }
  }
</style>
