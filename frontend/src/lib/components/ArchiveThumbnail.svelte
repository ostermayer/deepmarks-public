<script lang="ts">
  import { config } from '$lib/config';

  export let thumbHash: string | undefined = undefined;
  export let tier: string = '';
  export let url: string = '';

  let broken = false;

  $: src = thumbHash && !broken
    ? `${config.blossomUrl.replace(/\/$/, '')}/${encodeURIComponent(thumbHash)}`
    : '';
  $: host = hostOf(url);

  function hostOf(raw: string): string {
    try {
      return new URL(raw).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }
</script>

<div class="archive-thumb" class:placeholder={!src} class:private={tier === 'private'}>
  {#if src}
    <img
      src={src}
      alt=""
      loading="lazy"
      on:error={() => { broken = true; }}
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
  }
  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
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
  }
</style>
