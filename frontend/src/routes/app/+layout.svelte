<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import Header from '$lib/components/Header.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import InstallPrompt from '$lib/components/InstallPrompt.svelte';
  import NativeTabBar from '$lib/components/NativeTabBar.svelte';
  import { isNativeShell } from '$lib/native/runtime';
  import { currentSession, session } from '$lib/stores/session';

  // Public feeds any visitor (signed in or not) can browse. Everything
  // else under /app/ requires a session.
  const PUBLIC_APP_PATHS = ['/app/recent', '/app/popular'];
  let settingsSyncedFor = '';
  let settingsSyncInFlightFor = '';
  let nativeShell = isNativeShell();

  onMount(() => {
    nativeShell = isNativeShell();
    let stopSettingsRelays: (() => void) | null = null;
    const stopSessionSync = session.subscribe((state) => {
      if (state.pubkey && state.signer) void syncSettings(state.pubkey);
    });
    void Promise.all([
      import('$lib/stores/user-settings'),
      import('$lib/nostr/ndk'),
      import('$lib/nostr/lifetime-archive-backfill'),
    ]).then(([settingsModule, ndkModule, backfillModule]) => {
      backfillModule.startLifetimeArchiveBackfill();
      stopSettingsRelays = settingsModule.userSettings.subscribe((settings) => {
        const relayUrls = settings.relays
          .filter((r) => r.read || r.write)
          .map((r) => r.url);
        ndkModule.ensureRelayUrlsConnected(relayUrls);
      });
    }).catch(() => {
      // Relay connection health is surfaced in the sidebar; keep routing intact.
    });
    const timer = setTimeout(() => {
      void enforceSession();
    }, 0);
    return () => {
      clearTimeout(timer);
      stopSettingsRelays?.();
      stopSessionSync();
    };
  });

  async function enforceSession() {
    const path = window.location.pathname;
    if (PUBLIC_APP_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return;
    const params = new URLSearchParams(window.location.search);

    // Auto-login only through the first-party Deepmarks extension. Other
    // NIP-07 providers remain supported from the explicit /login button,
    // but we do not silently ask Alby/nos2x/etc. for access.
    const explicitExtensionLaunch = params.get('source') === 'extension';
    const extensionAutoLogin = await import('$lib/nostr/extension-autologin');
    if (extensionAutoLogin.shouldAttemptDeepmarksAutoLogin(explicitExtensionLaunch)) {
      try {
        const pubkey = await extensionAutoLogin.loginWithDeepmarksExtension();
        if (pubkey) void syncSettings(pubkey);
        if (pubkey) void handleUpgradeReturn(pubkey, params, path);
        // Strip the marker from the URL so it's not preserved on
        // share / bookmark / refresh.
        params.delete('source');
        const search = params.toString();
        history.replaceState({}, '', `${path}${search ? `?${search}` : ''}`);
        return;
      } catch {
        // Extension declined or absent under the hood — fall through.
      }
    }

    // Rehydrate before deciding whether the private app can render. A
    // persisted account hint is a valid signed-in identity even when the
    // signer itself still needs a passkey unlock / extension reconnect.
    // Signer-gated actions surface their own reconnect controls.
    await session.rehydrate();
    const pubkey = currentSession().pubkey;
    if (pubkey) {
      void syncSettings(pubkey);
      void handleUpgradeReturn(pubkey, params, path);
      return;
    }

    const redirect = `${path}${window.location.search}`;
    void goto(`/login?redirect=${encodeURIComponent(redirect)}`);
  }

  async function syncSettings(pubkey: string): Promise<void> {
    const signer = currentSession().signer;
    if (!signer) return;
    const key = `${pubkey}:${signer.kind}`;
    if (settingsSyncedFor === key || settingsSyncInFlightFor === key) return;
    settingsSyncInFlightFor = key;
    try {
      const [{ api }, { userSettings }] = await Promise.all([
        import('$lib/api/client'),
        import('$lib/stores/user-settings'),
      ]);
      const remote = await api.account.getSettings();
      userSettings.update((current) => (
        remote.updatedAt >= current.syncedAt
          ? { ...current, ...remote, syncedAt: remote.updatedAt }
          : current
      ));
      settingsSyncedFor = key;
    } catch {
      // Local settings remain valid when relays are slow.
    } finally {
      if (settingsSyncInFlightFor === key) settingsSyncInFlightFor = '';
    }
  }

  async function handleUpgradeReturn(pubkey: string, params: URLSearchParams, path: string): Promise<void> {
    if (params.get('upgraded') !== '1') return;
    params.delete('upgraded');
    const search = params.toString();
    history.replaceState({}, '', `${path}${search ? `?${search}` : ''}`);
    try {
      const [{ setLifetimeStatus }, { api }, { userSettings }] = await Promise.all([
        import('$lib/nostr/lifetime-status'),
        import('$lib/api/client'),
        import('$lib/stores/user-settings'),
      ]);
      setLifetimeStatus(pubkey, true);
      const remote = await api.account.getSettings();
      const next = { ...remote, archiveAllByDefault: true, archiveDefaultManualOverride: false };
      const saved = await api.account.putSettings({
        relays: next.relays,
        defaultTags: next.defaultTags,
        defaultVisibility: next.defaultVisibility,
        archiveAllByDefault: true,
        archiveDefaultManualOverride: false,
        backupBlossomServers: next.backupBlossomServers,
      });
      userSettings.update((current) => ({ ...current, ...saved, syncedAt: saved.updatedAt }));
      settingsSyncedFor = pubkey;
    } catch {
      // Upgrade is server-stamped by the webhook. If settings sync fails,
      // the normal settings loader keeps local defaults working.
    }
  }
</script>


<div class:native-app-shell={nativeShell}>
  <Header />

  <slot />
</div>

{#if nativeShell}
  <NativeTabBar />
{:else}
  <Footer />
  <InstallPrompt />
{/if}

<style>
  .native-app-shell {
    padding-bottom: calc(72px + env(safe-area-inset-bottom, 0px));
  }
</style>
