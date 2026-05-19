<script lang="ts">
  // "Add Ons" — paid extras that sit above the lifetime baseline.
  // Per-purchase Lightning invoices, no subscription.
  //
  // First add-on is "Archive YouTube videos": a 150,000-sat per-video
  // archive that runs yt-dlp on Box B (capped at 720p), encrypts the
  // result client-side, and stores it as a private blob in our
  // ciphertext bucket. Always private regardless of the user's
  // default visibility — the source YouTube URL stays public, but
  // the downloaded MP4 sits behind the user's archive key.

  import YoutubeArchiveDialog from './YoutubeArchiveDialog.svelte';

  let showYoutubeDialog = false;
</script>

<section class="addons">
  <h2>add-ons</h2>
  <p class="muted">paid extras for archive needs that go beyond the lifetime baseline. each purchase is a one-time Lightning invoice — no subscriptions.</p>

  <article class="addon">
    <header>
      <div>
        <h3>archive youtube videos</h3>
        <p class="addon-desc">save a YouTube video as a private archive in your library. capped at 720p; downloaded with yt-dlp and stored encrypted in our ciphertext bucket. the bookmark itself can stay public — only the video file is private.</p>
      </div>
      <div class="price">
        <strong>150,000</strong>
        <span>sats per video</span>
      </div>
    </header>
    <button type="button" class="cta" on:click={() => { showYoutubeDialog = true; }}>archive a YouTube video</button>
  </article>
</section>

{#if showYoutubeDialog}
  <YoutubeArchiveDialog on:close={() => { showYoutubeDialog = false; }} />
{/if}

<style>
  .addons { margin-top: 32px; }
  h2 {
    font-size: 12px;
    text-transform: uppercase;
    color: var(--ink-deep);
    letter-spacing: 0;
    margin: 0 0 12px;
    padding-bottom: 6px;
    font-weight: 600;
    border-bottom: 1px solid var(--rule);
  }
  .muted { color: var(--ink-deep); font-size: 14px; line-height: 1.6; margin: 0 0 16px; }
  .addon {
    border: 1px solid var(--rule);
    border-radius: 8px;
    padding: 16px;
    background: var(--surface);
  }
  .addon header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
    margin-bottom: 12px;
  }
  .addon h3 { margin: 0 0 4px; font-size: 16px; color: var(--ink-deep); font-weight: 600; }
  .addon-desc { color: var(--ink); font-size: 13px; line-height: 1.5; margin: 0; }
  .price { text-align: right; white-space: nowrap; }
  .price strong { display: block; font-size: 18px; color: var(--coral-deep); font-variant-numeric: tabular-nums; }
  .price span { font-size: 11px; color: var(--muted); }
  .cta {
    background: var(--coral);
    color: var(--on-coral);
    border: 0;
    padding: 8px 16px;
    border-radius: 100px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
  }
  .cta:hover { background: var(--coral-deep); }
</style>
