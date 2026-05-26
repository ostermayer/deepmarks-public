<script lang="ts">
  // First-time native users see a dismissible card explaining how to
  // pin Deepmarks at the top of the iOS share sheet. iOS doesn't let
  // apps auto-pin themselves — it has to be a one-time manual step.
  //
  // Dismissed permanently after the user taps "Got it"; key is local
  // to this device (localStorage, no Nostr sync) since the choice is
  // device-specific.

  import { onMount } from 'svelte';
  import { isNativeShell, nativePlatform } from '$lib/native/runtime';

  const LS_KEY = 'deepmarks-share-pin-onboarded-v1';
  let visible = false;

  onMount(() => {
    if (!isNativeShell()) return;
    if (nativePlatform() !== 'ios') return;
    try {
      if (localStorage.getItem(LS_KEY) === '1') return;
    } catch {
      // Private mode / quota — show the card; user can always dismiss.
    }
    visible = true;
  });

  function dismiss(): void {
    visible = false;
    try { localStorage.setItem(LS_KEY, '1'); } catch { /* tolerable */ }
  }
</script>

{#if visible}
  <aside class="card" role="note" aria-label="Pin Deepmarks to your iOS share sheet">
    <div class="head">
      <span class="title">Save from anywhere on iOS</span>
      <button
        type="button"
        class="close"
        on:click={dismiss}
        aria-label="Dismiss share-sheet tip"
      >×</button>
    </div>
    <ol>
      <li>Open Safari (or any app), tap <strong>Share</strong>.</li>
      <li>Scroll the icon row right and tap <strong>More</strong>.</li>
      <li>Find Deepmarks, switch it on, and drag it to the top.</li>
    </ol>
    <p class="footnote">
      iOS doesn't allow apps to auto-pin themselves to the share sheet —
      this is a one-time setup.
    </p>
    <button type="button" class="primary" on:click={dismiss}>Got it</button>
  </aside>
{/if}

<style>
  .card {
    margin: 0 16px 14px;
    padding: 14px 16px 16px;
    border: 1px solid var(--rule);
    border-left: 4px solid var(--coral);
    border-radius: 10px;
    background: var(--surface);
    color: var(--ink-deep);
    font-size: 14px;
    line-height: 1.5;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }
  .title {
    font-weight: 600;
    color: var(--ink-deep);
  }
  .close {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 22px;
    line-height: 1;
    padding: 4px 6px;
    cursor: pointer;
  }
  ol {
    margin: 0 0 8px 18px;
    padding: 0;
    color: var(--ink);
  }
  ol li { margin: 2px 0; }
  ol li strong { color: var(--ink-deep); }
  .footnote {
    margin: 0 0 10px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
  }
  .primary {
    appearance: none;
    background: var(--coral);
    border: 1px solid var(--coral-deep, var(--coral));
    color: white;
    font: inherit;
    font-weight: 600;
    padding: 7px 18px;
    border-radius: 6px;
    cursor: pointer;
  }
</style>
