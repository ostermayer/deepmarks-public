<script lang="ts">
  // Settings section for Web Push subscription. Lets the user opt-in
  // to push notifications for zap receipts on their bookmarks. iOS
  // Capacitor builds skip the subscribe path — they'd need APNs via
  // a native Capacitor plugin, which we don't ship yet.

  import { onMount } from 'svelte';
  import {
    detectPushStatus,
    subscribeToPush,
    unsubscribeFromPush,
    type PushStatus,
  } from '$lib/push/subscribe';
  import { isNativeShell } from '$lib/native/runtime';
  import SettingsSection from './SettingsSection.svelte';

  let status: PushStatus = { status: 'unsupported' };
  let busy = false;
  let error = '';
  let nativeShell = isNativeShell();

  onMount(async () => {
    nativeShell = isNativeShell();
    if (nativeShell) return;
    status = await detectPushStatus();
  });

  async function enable(): Promise<void> {
    busy = true;
    error = '';
    try {
      status = await subscribeToPush();
    } catch (e) {
      error = (e as Error).message ?? 'subscribe failed';
    } finally {
      busy = false;
    }
  }

  async function disable(): Promise<void> {
    busy = true;
    error = '';
    try {
      status = await unsubscribeFromPush();
    } catch (e) {
      error = (e as Error).message ?? 'unsubscribe failed';
    } finally {
      busy = false;
    }
  }
</script>

<SettingsSection title="push notifications" note={nativeShell ? '(coming soon)' : ''}>
  {#if nativeShell}
    <p class="settings-section-copy">
      Mobile app push notifications are coming soon. Web push notifications
      remain available when you use Deepmarks in a supported browser.
    </p>
  {:else if status.status === 'unsupported'}
    <p class="settings-section-copy">
      This browser doesn't support web push notifications. Try Chrome,
      Firefox, or Safari (16.4+ on iOS, installed as a Home Screen
      app).
    </p>
  {:else if status.status === 'no-vapid'}
    <p class="settings-section-copy">
      Push notifications aren't configured on this Deepmarks instance.
      Operators: see <code>VAPID_PUBLIC_KEY</code> in
      <code>deploy/box-a/.env</code>.
    </p>
  {:else if status.status === 'denied'}
    <p class="settings-section-copy">
      You blocked push notifications for deepmarks.org. Re-enable them
      in your browser's site settings, then come back here.
    </p>
  {:else if status.status === 'subscribed'}
    <p class="settings-section-copy">
      Push notifications are on. You'll get a notification when someone
      zaps one of your bookmarks.
    </p>
    <button type="button" on:click={disable} disabled={busy}>
      {busy ? 'disabling…' : 'turn off push notifications'}
    </button>
  {:else}
    <p class="settings-section-copy">
      Get a notification when someone zaps one of your bookmarks. Your
      browser asks for permission once; you can turn it off any time.
    </p>
    <button type="button" class="primary" on:click={enable} disabled={busy}>
      {busy ? 'subscribing…' : 'turn on push notifications'}
    </button>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}
</SettingsSection>

<style>
  button {
    font: inherit;
    padding: 8px 16px;
    border-radius: 100px;
    cursor: pointer;
  }
  button.primary {
    background: var(--coral);
    color: var(--on-coral);
    border: 0;
    font-weight: 500;
  }
  button.primary:disabled { opacity: 0.6; cursor: progress; }
  .error { color: var(--coral-deep); font-size: 13px; margin-top: 8px; }
</style>
