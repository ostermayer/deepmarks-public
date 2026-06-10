<script lang="ts">
  // Thumbnail for an archive row. Three rendering modes:
  //   1. Real screenshot blob if the worker uploaded one (public tier).
  //   2. Site favicon if not — private archives never get a screenshot
  //      since the JPEG would leak page contents the encrypted blob
  //      otherwise hides. Favicons are already public per-site.
  //   3. Generic glyph if both fail.

  import { config } from '$lib/config';

  export let thumbHash: string | undefined = undefined;
  export let tier: string = '';
  export let url: string = '';

  let blobBroken = false;
  let faviconBroken = false;

  $: blobSrc = thumbHash && !blobBroken
    ? `${config.blossomUrl.replace(/\/$/, '')}/${encodeURIComponent(thumbHash)}`
    : '';
  $: host = hostOf(url);
  $: faviconSrc = !blobSrc && host && !faviconBroken
    ? `${config.apiBase.replace(/\/$/, '')}/favicon?host=${encodeURIComponent(host)}`
    : '';

  function hostOf(raw: string): string {
    try {
      return new URL(raw).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }
</script>

<div
  class="archive-thumb"
  class:placeholder={!blobSrc}
  class:private={tier === 'private'}
  class:favicon-mode={!blobSrc && !!faviconSrc}
>
  {#if blobSrc}
    <img
      src={blobSrc}
      alt=""
      loading="lazy"
      on:error={() => { blobBroken = true; }}
    />
  {:else if faviconSrc}
    <img
      class="favicon-img"
      src={faviconSrc}
      alt=""
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      on:error={() => { faviconBroken = true; }}
    />
  {:else}
    <div class="fallback" aria-hidden="true">
      <span>{tier === 'private' ? 'private' : 'archive'}</span>
      {#if host}<small>{host}</small>{/if}
    </div>
  {/if}
</div>

<style>
  .archive-thumb {
    width: 96px;
    height: 64px;
    flex: 0 0 96px;
    overflow: hidden;
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: var(--paper-warm);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .favicon-img {
    width: 40px;
    height: 40px;
    object-fit: contain;
    background: transparent;
  }
  .favicon-mode {
    background: var(--paper-warm);
  }
  .private.favicon-mode {
    background: repeating-linear-gradient(
      135deg,
      var(--surface),
      var(--surface) 8px,
      var(--paper-warm) 8px,
      var(--paper-warm) 16px
    );
  }
  .fallback {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 8px;
    color: var(--muted);
    text-align: center;
    line-height: 1.2;
  }
  .fallback span {
    color: var(--ink-deep);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .fallback small {
    max-width: 100%;
    overflow: hidden;
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .private .fallback {
    background: repeating-linear-gradient(
      135deg,
      var(--surface),
      var(--surface) 8px,
      var(--paper-warm) 8px,
      var(--paper-warm) 16px
    );
  }
  @media (max-width: 480px) {
    .archive-thumb {
      width: 76px;
      height: 52px;
      flex-basis: 76px;
    }
    .favicon-img {
      width: 32px;
      height: 32px;
    }
  }
</style>
