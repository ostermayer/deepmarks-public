<script lang="ts">
  import { onMount } from 'svelte';
  import {
    clearMobileAppLock,
    initMobileAppLock,
    lockMobileApp,
    mobileAppLock,
    setMobileAppBiometricLock,
    setMobileAppPassword,
    setMobileAppPin,
  } from '$lib/mobile/app-lock';
  import SettingsSection from './SettingsSection.svelte';

  let mode: 'pin' | 'password' | 'biometric' = 'pin';
  let secret = '';
  let confirm = '';
  let status = '';
  let error = '';
  let busy = false;

  onMount(() => {
    void initMobileAppLock();
  });

  async function save() {
    busy = true;
    error = '';
    status = '';
    try {
      if (mode === 'pin') {
        if (secret !== confirm) throw new Error('PINs do not match');
        await setMobileAppPin(secret);
      } else if (mode === 'password') {
        if (secret !== confirm) throw new Error('passwords do not match');
        await setMobileAppPassword(secret);
      } else {
        await setMobileAppBiometricLock();
      }
      secret = '';
      confirm = '';
      status = 'app lock updated';
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function disable() {
    busy = true;
    error = '';
    status = '';
    try {
      await clearMobileAppLock();
      status = 'app lock disabled';
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<SettingsSection title="app lock">
  <p class="settings-section-copy">
    Lock the mobile app when it leaves the foreground. This protects the app shell;
    recovery-key reveal still asks for its own password.
  </p>
  <p class="settings-section-copy compact">
    Current: <strong>{$mobileAppLock.enabled ? $mobileAppLock.mode : 'off'}</strong>
    {#if $mobileAppLock.mode === 'biometric' && $mobileAppLock.biometricType}
      · {$mobileAppLock.biometricType}
    {/if}
  </p>

  <div class="mode-row" role="group" aria-label="app lock mode">
    <button type="button" class:active={mode === 'pin'} on:click={() => mode = 'pin'}>PIN</button>
    <button type="button" class:active={mode === 'password'} on:click={() => mode = 'password'}>password</button>
    <button
      type="button"
      class:active={mode === 'biometric'}
      disabled={!$mobileAppLock.biometricAvailable}
      on:click={() => mode = 'biometric'}
    >biometric</button>
  </div>

  {#if mode === 'biometric'}
    <p class="settings-section-copy compact">
      {#if $mobileAppLock.biometricAvailable}
        Uses {$mobileAppLock.biometricType || 'device biometrics'} to unlock Deepmarks.
      {:else}
        Biometric unlock is not available on this device or simulator.
      {/if}
    </p>
  {:else}
    <div class="secret-grid">
      <input
        type="password"
        inputmode={mode === 'pin' ? 'numeric' : undefined}
        placeholder={mode === 'pin' ? 'new PIN' : 'new password'}
        bind:value={secret}
      />
      <input
        type="password"
        inputmode={mode === 'pin' ? 'numeric' : undefined}
        placeholder={mode === 'pin' ? 'confirm PIN' : 'confirm password'}
        bind:value={confirm}
        on:keydown={(e) => e.key === 'Enter' && save()}
      />
    </div>
  {/if}

  <div class="actions">
    <button class="primary" type="button" on:click={save} disabled={busy || (mode === 'biometric' && !$mobileAppLock.biometricAvailable)}>
      {busy ? 'saving...' : 'enable lock'}
    </button>
    {#if $mobileAppLock.enabled}
      <button class="ghost" type="button" on:click={lockMobileApp}>lock now</button>
      <button class="ghost" type="button" on:click={disable} disabled={busy}>turn off</button>
    {/if}
  </div>

  {#if status}<p class="status">{status}</p>{/if}
  {#if error}<p class="status error">{error}</p>{/if}
</SettingsSection>

<style>
  .compact { margin-top: -2px; }
  .mode-row,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }
  .mode-row button {
    background: var(--surface);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 7px 14px;
    border-radius: 999px;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
  }
  .mode-row button.active {
    border-color: var(--coral);
    color: var(--coral-deep);
  }
  .mode-row button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .secret-grid {
    display: grid;
    gap: 8px;
    margin-top: 10px;
    max-width: 360px;
  }
  input {
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink-deep);
    font: inherit;
    padding: 9px 11px;
  }
  .primary,
  .ghost {
    border-radius: 999px;
    cursor: pointer;
    font: inherit;
    font-size: 14px;
    padding: 8px 16px;
  }
  .primary {
    border: 0;
    background: var(--coral);
    color: var(--on-coral);
  }
  .ghost {
    border: 1px solid var(--rule);
    background: transparent;
    color: var(--ink-deep);
  }
  .primary:disabled,
  .ghost:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .status {
    margin: 8px 0 0;
    color: var(--ink);
    font-size: 13px;
  }
  .error {
    color: var(--coral-deep);
  }
</style>
