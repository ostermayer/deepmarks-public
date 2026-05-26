<script lang="ts">
  import Logo from '$lib/components/Logo.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import { EXTENSION_LINKS } from '$lib/extension-links';
</script>

<svelte:head><title>browser extension — Deepmarks</title></svelte:head>

<main class="page">
  <a href="/" class="back"><Logo size={20} flip /> back</a>

  <header>
    <div class="title-row">
      <Logo size={24} />
      <div>
        <h1>Deepmarks browser extension</h1>
        <p>
          save pages from the toolbar, use Deepmarks as your Nostr signer, and keep daily signing
          out of the website tab.
        </p>
      </div>
    </div>
  </header>

  <section class="stores" aria-label="extension downloads">
    <a class="store-card" href={EXTENSION_LINKS.chrome} target="_blank" rel="noreferrer">
      <span class="kicker">available now</span>
      <strong>Chrome</strong>
      <span>Chrome Web Store</span>
    </a>
    <a class="store-card" href={EXTENSION_LINKS.firefox} target="_blank" rel="noreferrer">
      <span class="kicker">available now</span>
      <strong>Firefox</strong>
      <span>Mozilla Add-ons</span>
    </a>
  </section>

  <section class="notes">
    <h2>what it does</h2>
    <ul>
      <li>sign in to Deepmarks without pasting your recovery key into the website</li>
      <li>save public or private bookmarks from any normal web page</li>
      <li>use your Deepmarks identity as a NIP-07 signer for compatible Nostr apps</li>
      <li>connect Nostr Wallet Connect for one-tap zaps where supported</li>
    </ul>
  </section>
</main>

<Footer />

<style>
  .page {
    max-width: 760px;
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
  .stores {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
    margin-bottom: 26px;
    border-top: 1px solid var(--rule);
    padding-top: 18px;
  }
  .store-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 116px;
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
  .store-card strong {
    font-size: 18px;
    line-height: 1.25;
  }
  .store-card span {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.45;
  }
  .store-card .kicker {
    color: var(--coral-deep);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
  }
  .notes {
    border-top: 1px solid var(--rule);
    padding-top: 22px;
  }
  h2 {
    margin: 0 0 12px;
    color: var(--ink-deep);
    font-size: 12px;
    letter-spacing: 1.4px;
    text-transform: uppercase;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    padding: 6px 0;
    color: var(--ink);
    font-size: 14px;
    line-height: 1.5;
  }
  li::before {
    content: '+ ';
    color: var(--coral-deep);
    font-weight: 600;
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
    .stores {
      grid-template-columns: 1fr;
      gap: 10px;
      margin-bottom: 22px;
      padding-top: 14px;
    }
    .store-card {
      min-height: 0;
      padding: 14px;
    }
    .notes {
      padding-top: 18px;
    }
  }
</style>
