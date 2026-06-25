<script lang="ts">
  // Brief toast shown after the iOS Share Extension drain runs silently
  // in the background, so the user gets confirmation that the bookmark
  // they shared from Safari actually landed.

  import { onDestroy } from 'svelte';
  import { lastShareDrainResult } from '$lib/mobile/share-drain';
  import { isNativeShell } from '$lib/native/runtime';

  const VISIBLE_MS = 2400;
  let visible = false;
  let messageText = '';
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSeqShown = 0;

  $: native = isNativeShell();
  $: if (
    native &&
    $lastShareDrainResult.seq > 0 &&
    $lastShareDrainResult.seq !== lastSeqShown &&
    ($lastShareDrainResult.saved > 0 || $lastShareDrainResult.failed > 0)
  ) {
    lastSeqShown = $lastShareDrainResult.seq;
    show($lastShareDrainResult);
  }

  function show(result: { saved: number; failed: number; message?: string }): void {
    if (result.saved > 0) {
      messageText = result.saved === 1
        ? 'saved bookmark from share'
        : `saved ${result.saved} bookmarks from share`;
    } else if (result.failed > 0) {
      messageText = result.message
        ? `share save failed — ${result.message}`
        : 'share save failed';
    } else {
      return;
    }
    visible = true;
    if (dismissTimer) clearTimeout(dismissTimer);
    dismissTimer = setTimeout(() => { visible = false; }, VISIBLE_MS);
  }

  onDestroy(() => {
    if (dismissTimer) clearTimeout(dismissTimer);
  });
</script>

{#if native && visible}
  <div class="toast" role="status" aria-live="polite">
    <span class="glyph" aria-hidden="true">✓</span>
    <span>{messageText}</span>
  </div>
{/if}

<style>
  .toast {
    position: fixed;
    z-index: 10002;
    left: 50%;
    bottom: calc(env(safe-area-inset-bottom, 0px) + 84px);
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 14px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ink-deep) 92%, black);
    color: var(--paper);
    box-shadow: 0 8px 22px rgba(5, 43, 68, 0.32);
    font-size: 13px;
    line-height: 1;
    pointer-events: none;
    max-width: calc(100vw - 32px);
    white-space: nowrap;
  }
  .glyph {
    display: inline-flex;
    width: 16px;
    height: 16px;
    align-items: center;
    justify-content: center;
    color: var(--coral);
  }
</style>
