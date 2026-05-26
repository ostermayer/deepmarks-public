<script lang="ts">
  // Single source of truth for "the small round avatar of a user" across
  // the app.
  //
  //   1. Real NIP-01 kind:0 picture  — shown as <img> if the user set one
  //   2. Pixel identicon fallback    — deterministic symmetric 7×7 SVG
  //                                     derived from the pubkey hash
  //
  // We render the identicon as SVG (shape-rendering crispEdges) so the
  // edges stay pixel-sharp regardless of display pixel ratio.

  import { nip19 } from 'nostr-tools';
  import { getProfile } from '$lib/nostr/profiles';
  import { buildPixelMonster } from '$lib/util/pixel-monster';

  /** 32-byte hex pubkey of the user being rendered. */
  export let pubkey: string;
  /** Pixel dimension of the rendered circle. */
  export let size: number = 34;
  /** Optional label override (for the tooltip / a11y). */
  export let label: string | undefined = undefined;

  $: profile = getProfile(pubkey);
  $: npub = (() => {
    try { return nip19.npubEncode(pubkey); } catch { return undefined; }
  })();
  $: pictureFailed = false;
  $: pictureUrl = $profile?.picture && !pictureFailed ? $profile.picture : undefined;
  $: monster = buildPixelMonster(pubkey);
</script>

<span
  class="avatar"
  style="--size: {size}px;"
  title={label ?? $profile?.displayName ?? npub ?? pubkey}
>
  {#if pictureUrl}
    <img
      src={pictureUrl}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      on:error={() => (pictureFailed = true)}
    />
  {:else}
    <svg
      width={size}
      height={size}
      viewBox="0 0 {monster.size} {monster.size}"
      shape-rendering="crispEdges"
      aria-hidden="true"
    >
      <rect width={monster.size} height={monster.size} fill={monster.background} />
      {#each monster.cells as row, y}
        {#each row as kind, x}
          {#if kind === 'body' || kind === 'antenna'}
            <rect x={x} y={y} width="1" height="1" fill={monster.body} />
          {:else if kind === 'eye'}
            <rect x={x} y={y} width="1" height="1" fill={monster.eye} />
          {:else if kind === 'mouth'}
            <rect x={x} y={y} width="1" height="1" fill={monster.mouth} />
          {/if}
        {/each}
      {/each}
    </svg>
  {/if}
</span>

<style>
  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--size);
    height: var(--size);
    border-radius: 50%;
    overflow: hidden;
    flex-shrink: 0;
    user-select: none;
    background: var(--paper-warm);
  }
  .avatar img,
  .avatar svg {
    width: 100%;
    height: 100%;
    display: block;
    image-rendering: pixelated;
  }
  .avatar img {
    object-fit: cover;
    image-rendering: auto;
  }
</style>
