<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { isNativeShell } from '$lib/native/runtime';

  const THRESHOLD = 78;
  const MAX_PULL = 118;

  let enabled = false;
  let startY = 0;
  let pull = 0;
  let tracking = false;
  let active = false;
  let refreshing = false;

  $: progress = Math.min(1, pull / THRESHOLD);
  $: ready = pull >= THRESHOLD;

  function scrollTop(): number {
    return document.scrollingElement?.scrollTop ?? window.scrollY ?? 0;
  }

  function shouldIgnoreTarget(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');
  }

  function onTouchStart(event: TouchEvent): void {
    if (refreshing || event.touches.length !== 1 || shouldIgnoreTarget(event.target)) return;
    if (scrollTop() > 0) return;
    startY = event.touches[0]?.clientY ?? 0;
    pull = 0;
    active = false;
    tracking = true;
  }

  function onTouchMove(event: TouchEvent): void {
    if (!tracking || refreshing || event.touches.length !== 1) return;
    const y = event.touches[0]?.clientY ?? startY;
    const delta = y - startY;
    if (delta <= 0) {
      pull = 0;
      active = false;
      return;
    }
    if (scrollTop() > 0 && !active) {
      tracking = false;
      return;
    }
    active = delta > 8;
    if (!active) return;
    event.preventDefault();
    pull = Math.min(MAX_PULL, Math.round(delta * 0.55));
  }

  function reset(): void {
    active = false;
    tracking = false;
    pull = 0;
  }

  function onTouchEnd(): void {
    if (!tracking && !active) return;
    if (active && pull >= THRESHOLD) {
      refreshing = true;
      pull = THRESHOLD;
      window.setTimeout(() => {
        window.location.reload();
      }, 160);
      return;
    }
    reset();
  }

  function onTouchCancel(): void {
    if (!refreshing) reset();
  }

  onMount(() => {
    enabled = isNativeShell();
    if (!enabled) return;
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchCancel, { passive: true });
  });

  onDestroy(() => {
    if (!enabled) return;
    window.removeEventListener('touchstart', onTouchStart);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
    window.removeEventListener('touchcancel', onTouchCancel);
  });
</script>

{#if enabled && (active || refreshing)}
  <div
    class="pull-refresh"
    class:ready
    class:refreshing
    style={`transform: translate3d(-50%, ${Math.max(0, pull - 54)}px, 0); opacity: ${Math.max(0.25, progress)};`}
    aria-live="polite"
  >
    <span class="glyph" aria-hidden="true">{refreshing ? '↻' : ready ? '↑' : '↓'}</span>
    <span>{refreshing ? 'refreshing' : ready ? 'release' : 'pull'}</span>
  </div>
{/if}

<style>
  .pull-refresh {
    position: fixed;
    z-index: 10001;
    top: calc(env(safe-area-inset-top, 0px) + 10px);
    left: 50%;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 32px;
    padding: 6px 12px;
    border: 1px solid var(--rule);
    border-radius: 999px;
    background: color-mix(in srgb, var(--paper) 94%, white);
    color: var(--ink-deep);
    box-shadow: 0 6px 20px rgba(5, 43, 68, 0.16);
    font-size: 12px;
    line-height: 1;
    pointer-events: none;
    transition: opacity 120ms ease, transform 120ms ease;
  }
  .glyph {
    display: inline-flex;
    width: 16px;
    height: 16px;
    align-items: center;
    justify-content: center;
    color: var(--coral-deep);
    font-size: 15px;
    line-height: 1;
  }
  .ready {
    border-color: var(--coral);
  }
  .refreshing .glyph {
    animation: spin 800ms linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
