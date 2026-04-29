<script lang="ts">
  // PWA install banner. Listens for `beforeinstallprompt` (Chromium /
  // Edge / Samsung Internet) and surfaces an install affordance the
  // user can dismiss with a tap. iOS Safari doesn't fire the event but
  // we show a one-line hint to "share → add to home screen" when we
  // detect Mobile Safari.
  //
  // Dismissal is stored in localStorage so we don't pester the user
  // every page load. Resurfaces if the user clears storage or if a
  // future ?install=1 query param lands them here intentionally.

  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';

  // Chrome's BeforeInstallPromptEvent isn't in lib.dom; we type
  // narrowly to the surface we use.
  interface InstallEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  }

  const DISMISSED_KEY = 'deepmarks-install-dismissed-v1';

  let promptEvent: InstallEvent | null = null;
  let visible = false;
  let isIosSafari = false;

  function detectIosSafari(): boolean {
    if (!browser) return false;
    const ua = navigator.userAgent;
    const isIos = /iPhone|iPad|iPod/.test(ua);
    const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    const isStandalone = (navigator as { standalone?: boolean }).standalone === true;
    return isIos && isSafari && !isStandalone;
  }

  function shouldShow(): boolean {
    if (!browser) return false;
    if (window.matchMedia?.('(display-mode: standalone)').matches) return false;
    try { return localStorage.getItem(DISMISSED_KEY) !== '1'; }
    catch { return true; }
  }

  function onBeforeInstall(e: Event) {
    e.preventDefault();
    promptEvent = e as InstallEvent;
    if (shouldShow()) visible = true;
  }

  async function install() {
    if (!promptEvent) return;
    visible = false;
    try {
      await promptEvent.prompt();
      await promptEvent.userChoice;
    } catch {
      /* user dismissed; nothing to do */
    } finally {
      promptEvent = null;
    }
  }

  function dismiss() {
    visible = false;
    try { localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* tolerable */ }
  }

  onMount(() => {
    if (!browser) return;
    isIosSafari = detectIosSafari();
    if (isIosSafari && shouldShow()) visible = true;
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
  });

  onDestroy(() => {
    if (browser) window.removeEventListener('beforeinstallprompt', onBeforeInstall);
  });
</script>

{#if visible}
  <div class="install" role="dialog" aria-label="install Deepmarks">
    <div class="msg">
      {#if isIosSafari}
        Add Deepmarks to your home screen — tap <span class="ico">⬆️</span> then <strong>Add to Home Screen</strong>.
      {:else}
        Install Deepmarks for one-tap access from your home screen.
      {/if}
    </div>
    {#if !isIosSafari}
      <button type="button" class="primary" on:click={install}>install</button>
    {/if}
    <button type="button" class="dismiss" on:click={dismiss} aria-label="dismiss">×</button>
  </div>
{/if}

<style>
  .install {
    position: fixed;
    left: 12px;
    right: 12px;
    bottom: 12px;
    z-index: 1000;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    background: var(--ink-deep);
    color: var(--paper);
    border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.16);
    font-size: 13px;
  }
  .msg { flex: 1; line-height: 1.4; }
  .ico { background: rgba(255,255,255,0.1); padding: 0 6px; border-radius: 4px; }
  .primary {
    background: var(--coral);
    color: var(--on-coral);
    border: 0;
    padding: 6px 14px;
    border-radius: 100px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .primary:hover { background: var(--coral-deep); }
  .dismiss {
    background: transparent;
    color: var(--paper);
    border: 0;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .dismiss:hover { background: rgba(255,255,255,0.1); }
  @media (min-width: 720px) {
    .install {
      left: auto;
      right: 24px;
      bottom: 24px;
      max-width: 420px;
    }
  }
</style>
