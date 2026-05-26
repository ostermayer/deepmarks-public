<script lang="ts">
  // Site favicon. The browser hits our /favicon endpoint with the host of
  // the bookmarked URL; the server 302s to a cached public-read Linode
  // object (or to a default SVG when the site has no resolvable favicon).
  //
  // On any rendering failure — endpoint down, DNS hiccup, completely
  // unparseable URL — we fall back to a neutral inline SVG so the row
  // layout doesn't collapse.

  import { config } from '$lib/config';

  /** Bookmarked page URL. We derive the host from it ourselves. */
  export let url: string;
  /** Pixel dimension of the rendered square. */
  export let size: number = 22;

  function hostFor(input: string): string | null {
    try {
      const u = new URL(input);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.host.toLowerCase();
    } catch {
      return null;
    }
  }

  $: host = hostFor(url);
  $: src = host
    ? `${config.apiBase}/favicon?host=${encodeURIComponent(host)}`
    : undefined;
  $: loadFailed = false;
</script>

<span class="favicon" style="--size: {size}px;" title={host ?? url}>
  {#if src && !loadFailed}
    <img
      {src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      on:error={() => (loadFailed = true)}
    />
  {:else}
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      shape-rendering="crispEdges"
      aria-hidden="true"
    >
      <rect width="32" height="32" fill="var(--paper-warm, #f4f1ec)" />
      <g fill="none" stroke="var(--muted, #6b8198)" stroke-width="1.5">
        <circle cx="16" cy="16" r="9" />
        <ellipse cx="16" cy="16" rx="4" ry="9" />
        <line x1="7" y1="16" x2="25" y2="16" />
      </g>
    </svg>
  {/if}
</span>

<style>
  .favicon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--size);
    height: var(--size);
    border-radius: 4px;
    overflow: hidden;
    flex-shrink: 0;
    background: var(--paper-warm);
    user-select: none;
  }
  .favicon img,
  .favicon svg {
    width: 100%;
    height: 100%;
    display: block;
  }
  .favicon img {
    object-fit: contain;
    background: var(--paper);
  }
</style>
