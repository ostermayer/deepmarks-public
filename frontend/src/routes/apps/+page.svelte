<script lang="ts">
  import Logo from '$lib/components/Logo.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import { APP_LINKS } from '$lib/app-links';
  import { EXTENSION_LINKS } from '$lib/extension-links';
</script>

<svelte:head><title>apps — Deepmarks</title></svelte:head>

<main class="page">
  <a href="/" class="back"><Logo size={20} flip /> back</a>

  <header>
    <div class="title-row">
      <Logo size={24} />
      <div>
        <h1>Deepmarks apps</h1>
        <p>save, archive, and share bookmarks from mobile and desktop browsers.</p>
      </div>
    </div>
  </header>

  <section aria-label="apps and browser extensions">
    <div class="store-grid">
      <a class="store-card primary" href={APP_LINKS.ios} target="_blank" rel="noreferrer">
        <span class="group">mobile</span>
        <span class="kicker">available now</span>
        <strong>iPhone and iPad</strong>
        <span>Download on the App Store</span>
      </a>
      <div class="store-card disabled" aria-disabled="true">
        <span class="group">mobile</span>
        <span class="kicker">coming soon</span>
        <strong>Android</strong>
        <span>Google Play release is in testing.</span>
      </div>
      <a class="store-card" href={EXTENSION_LINKS.chrome} target="_blank" rel="noreferrer">
        <span class="group">extension</span>
        <span class="kicker">available now</span>
        <strong>Chrome</strong>
        <span>Chrome Web Store</span>
      </a>
      <a class="store-card" href={EXTENSION_LINKS.firefox} target="_blank" rel="noreferrer">
        <span class="group">extension</span>
        <span class="kicker">available now</span>
        <strong>Firefox</strong>
        <span>Mozilla Add-ons</span>
      </a>
    </div>
  </section>
</main>

<Footer />

<style>
  .page {
    max-width: 960px;
    margin: 0 auto;
    padding: 52px 24px 40px;
    position: relative;
  }
  .back {
    position: absolute;
    top: 20px;
    left: 24px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--muted) !important;
    font-size: 12px;
    text-decoration: none;
  }
  .back:hover {
    color: var(--coral) !important;
    text-decoration: none;
  }
  header {
    margin-bottom: 22px;
  }
  .title-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 14px;
    align-items: center;
  }
  h1 {
    margin: 0 0 4px;
    color: var(--ink-deep);
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 26px;
    font-weight: 600;
    letter-spacing: 0;
  }
  header p {
    margin: 0;
    color: var(--ink);
    font-size: 15px;
    line-height: 1.6;
  }
  section {
    border-top: 1px solid var(--rule);
    padding-top: 18px;
    margin-top: 0;
  }
  .store-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 14px;
    align-items: stretch;
  }
  .store-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 128px;
    border: 2px solid var(--ink-deep);
    box-shadow: 3px 3px 0 var(--coral);
    background: var(--surface);
    padding: 18px;
    color: var(--ink-deep);
    text-decoration: none;
  }
  .store-card:hover {
    transform: translate(-1px, -1px);
    box-shadow: 4px 4px 0 var(--coral);
    text-decoration: none;
  }
  .store-card.primary {
    background: var(--paper);
  }
  .store-card.disabled {
    border-color: var(--rule);
    box-shadow: none;
    color: var(--muted);
  }
  .store-card.disabled:hover {
    transform: none;
  }
  .store-card strong {
    font-size: 18px;
    line-height: 1.25;
  }
  .store-card span {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.45;
  }
  .store-card .group {
    color: var(--muted);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
  }
  .store-card .kicker {
    color: var(--coral-deep);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
  }
  .store-card.disabled .kicker {
    color: var(--muted);
  }
  @media (max-width: 840px) {
    .store-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 640px) {
    .page {
      padding: 46px 18px 32px;
    }
    .back {
      top: 16px;
      left: 18px;
    }
    header {
      margin-bottom: 16px;
    }
    .title-row {
      gap: 10px;
      align-items: start;
    }
    h1 {
      font-size: 28px;
      margin-bottom: 2px;
    }
    header p {
      font-size: 14px;
      line-height: 1.45;
    }
    section {
      padding-top: 14px;
    }
    .store-grid {
      grid-template-columns: 1fr;
      gap: 10px;
    }
    .store-card {
      min-height: 0;
      padding: 14px;
    }
  }
</style>
