<script lang="ts">
  import { onMount } from 'svelte';
  import { isNativeShell } from '$lib/native/runtime';
  import {
    initMobileAppLock,
    lockMobileApp,
    mobileAppLock,
    unlockMobileApp,
  } from '$lib/mobile/app-lock';

  let nativeShell = isNativeShell();
  let secret = '';

  $: mode = $mobileAppLock.mode;
  $: needsSecret = mode === 'pin' || mode === 'password';

  onMount(() => {
    nativeShell = isNativeShell();
    if (!nativeShell) return;
    void initMobileAppLock();
    let disposed = false;
    let removeAppListener: (() => void) | null = null;
    void import('@capacitor/app').then(({ App }) => (
      App.addListener('appStateChange', ({ isActive }) => {
        if (!isActive) {
          lockMobileApp();
          return;
        }
        // Returning to foreground — pull any bookmarks saved from
        // other clients (web/extension) while we were paused so the
        // list is fresh by the time the user looks at it.
        void import('$lib/stores/own-bookmarks').then(({ refreshOwnBookmarks }) => {
          refreshOwnBookmarks();
        }).catch(() => { /* tolerable */ });
        // Drain anything the iOS Share Extension queued while we were
        // backgrounded so the bookmark shows up in the list without
        // the user having to do anything.
        void import('$lib/mobile/share-drain').then(({ drainPendingShares }) => {
          drainPendingShares();
        }).catch(() => { /* tolerable */ });
      })
    )).then((handle) => {
      if (disposed) void handle.remove();
      else removeAppListener = () => void handle.remove();
    }).catch(() => {});
    return () => {
      disposed = true;
      removeAppListener?.();
    };
  });

  async function unlock() {
    try {
      await unlockMobileApp(secret);
      secret = '';
    } catch {
      // The store owns the visible error.
    }
  }
</script>

{#if nativeShell && (!$mobileAppLock.initialized || ($mobileAppLock.enabled && $mobileAppLock.locked))}
  <div class="lock-screen" role="dialog" aria-modal="true" aria-label="Deepmarks app lock">
    <div class="lock-panel">
      <img src="/pennant.svg" alt="" width="34" height="34" />
      <h1>Deepmarks locked</h1>
      {#if !$mobileAppLock.initialized}
        <p>checking app lock...</p>
      {:else if mode === 'biometric'}
        <p>unlock with {$mobileAppLock.biometricType || 'biometrics'} to continue.</p>
        <button class="primary" type="button" on:click={unlock} disabled={$mobileAppLock.busy}>
          {$mobileAppLock.busy ? 'checking...' : 'unlock'}
        </button>
      {:else}
        <p>enter your {mode === 'pin' ? 'PIN' : 'password'} to continue.</p>
        <input
          type="password"
          inputmode={mode === 'pin' ? 'numeric' : undefined}
          autocomplete="current-password"
          placeholder={mode === 'pin' ? 'PIN' : 'password'}
          bind:value={secret}
          on:keydown={(e) => e.key === 'Enter' && unlock()}
        />
        <button class="primary" type="button" on:click={unlock} disabled={$mobileAppLock.busy || (needsSecret && !secret)}>
          {$mobileAppLock.busy ? 'checking...' : 'unlock'}
        </button>
      {/if}
      {#if $mobileAppLock.error}<p class="error">{$mobileAppLock.error}</p>{/if}
    </div>
  </div>
{/if}

<style>
  .lock-screen {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: grid;
    place-items: center;
    padding: calc(env(safe-area-inset-top, 0px) + 24px) 20px calc(env(safe-area-inset-bottom, 0px) + 24px);
    background: var(--paper);
    color: var(--ink-deep);
  }
  .lock-panel {
    width: min(100%, 360px);
    display: grid;
    gap: 12px;
    justify-items: start;
    border: 1px solid var(--rule);
    background: var(--surface);
    border-radius: 12px;
    padding: 22px;
    box-shadow: 0 20px 70px rgb(0 0 0 / 0.16);
  }
  h1 {
    margin: 0;
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 22px;
    letter-spacing: 0;
  }
  p {
    margin: 0;
    color: var(--ink);
    line-height: 1.5;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--paper);
    color: var(--ink-deep);
    font: inherit;
    padding: 11px 12px;
  }
  .primary {
    border: 0;
    border-radius: 999px;
    background: var(--coral);
    color: var(--on-coral);
    font: inherit;
    padding: 9px 18px;
  }
  .primary:disabled {
    opacity: 0.55;
  }
  .error {
    color: var(--coral-deep);
    font-size: 13px;
  }
</style>
