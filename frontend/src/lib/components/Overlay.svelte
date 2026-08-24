<script lang="ts">
  // Generic centered modal overlay. Mirrors the search overlay in
  // AppActionBar (backdrop blur, top-centered panel) so "add a bookmark"
  // and search share one look + behavior: Esc / click-outside to close,
  // focus moves into the panel on open and is restored on close, and Tab
  // is trapped inside the panel.
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';

  export let open = false;
  export let ariaLabel = 'dialog';

  const dispatch = createEventDispatcher<{ close: void }>();

  let panel: HTMLDivElement | null = null;
  let lastFocused: HTMLElement | null = null;
  let wasOpen = false;

  const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

  $: if (open && !wasOpen) {
    wasOpen = true;
    void onOpen();
  }
  $: if (!open && wasOpen) wasOpen = false;

  async function onOpen(): Promise<void> {
    lastFocused = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    await tick();
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
  }

  function close(): void {
    const restore = lastFocused;
    lastFocused = null;
    dispatch('close');
    void tick().then(() => restore?.focus());
  }

  function onDocumentKeydown(event: KeyboardEvent): void {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }

  function onPanelKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .filter((node) => !node.hasAttribute('disabled') && node.tabIndex >= 0);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  onMount(() => document.addEventListener('keydown', onDocumentKeydown));
  onDestroy(() => document.removeEventListener('keydown', onDocumentKeydown));
</script>

{#if open}
  <div
    class="overlay"
    role="presentation"
    on:pointerdown={(event) => {
      if (event.target === event.currentTarget) close();
    }}
  >
    <div
      bind:this={panel}
      class="panel"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabindex="-1"
      on:keydown={onPanelKeydown}
    >
      <button type="button" class="close" aria-label="close" on:click={close}>×</button>
      <slot />
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 120;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: clamp(64px, 12vh, 120px) 18px 18px;
    background: color-mix(in srgb, var(--paper) 72%, transparent);
    backdrop-filter: blur(2px);
  }
  .panel {
    position: relative;
    width: min(720px, 100%);
    max-height: calc(100vh - 96px);
    overflow: auto;
    padding: 16px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: 0 18px 45px var(--shadow);
  }
  .close {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 32px;
    height: 32px;
    border: 1px solid var(--rule);
    background: var(--surface);
    color: var(--link);
    border-radius: 8px;
    font-size: 20px;
    line-height: 1;
    padding: 0;
    cursor: pointer;
  }
  .close:hover {
    border-color: var(--coral);
    color: var(--coral-deep);
  }
  @media (max-width: 720px) {
    .overlay {
      padding-top: calc(18px + env(safe-area-inset-top, 0px));
    }
  }
</style>
