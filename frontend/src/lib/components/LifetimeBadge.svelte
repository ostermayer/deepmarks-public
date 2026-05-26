<script lang="ts">
  // Small pennant badge rendered next to an avatar when the pubkey belongs
  // to a lifetime member. Hover reveals the "lifetime member" tooltip
  // (native browser title attr — keeps it dependency-free and accessible).
  //
  // Renders absolutely nothing while status is unknown or false, so in the
  // common case (non-members) this component adds zero visual noise.

  import { getLifetimeStatus } from '$lib/nostr/lifetime-status';

  export let pubkey: string;
  /** Pennant sprite size in px. Tuned to sit proud of the avatar corner;
   *  the caller should size it to roughly one third of the avatar. */
  export let size: number = 14;

  $: status = getLifetimeStatus(pubkey);
</script>

{#if $status}
  <span
    class="badge"
    style="width:{size}px; height:{size}px"
    title="lifetime member"
    aria-label="lifetime member"
  >
    <svg viewBox="0 0 32 32" shape-rendering="crispEdges" width={size} height={size} role="img">
      <rect x="8" y="4" width="2" height="24" fill="#ff6b5a" />
      <rect x="10" y="6" width="4" height="2" fill="#ff6b5a" />
      <rect x="10" y="8" width="8" height="2" fill="#ff6b5a" />
      <rect x="10" y="10" width="12" height="2" fill="#ff6b5a" />
      <rect x="10" y="12" width="14" height="2" fill="#ff6b5a" />
      <rect x="10" y="14" width="12" height="2" fill="#ff6b5a" />
      <rect x="10" y="16" width="8" height="2" fill="#ff6b5a" />
      <rect x="10" y="18" width="4" height="2" fill="#ff6b5a" />
    </svg>
  </span>
{/if}

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: middle;
    line-height: 0;
    cursor: help;
  }
  .badge svg {
    display: block;
  }
</style>
