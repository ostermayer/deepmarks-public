<script lang="ts">
  import Logo from '$lib/components/Logo.svelte';
  import Footer from '$lib/components/Footer.svelte';

  const chromeUrl = 'https://chromewebstore.google.com/detail/deepmarks/hefiabmeleknfielegnadaapcaacapoo';
  const firefoxUrl = 'https://addons.mozilla.org/en-US/firefox/addon/deepmarks/';
</script>

<svelte:head><title>browser extension — Deepmarks</title></svelte:head>

<main class="page">
  <a href="/" class="back"><Logo size={20} flip /> back</a>

  <header>
    <Logo size={42} />
    <h1>Deepmarks browser extension</h1>
    <p>
      save pages from the toolbar, use Deepmarks as your Nostr signer, and keep daily signing
      out of the website tab.
    </p>
  </header>

  <section class="stores" aria-label="extension downloads">
    <a class="store-card" href={chromeUrl} target="_blank" rel="noreferrer">
      <strong>Chrome</strong>
      <span>Chrome Web Store</span>
    </a>
    <a class="store-card" href={firefoxUrl} target="_blank" rel="noreferrer">
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
    padding: 60px 24px 40px;
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
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
    margin-bottom: 26px;
  }
  h1 {
    margin: 0;
    color: var(--ink-deep);
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 32px;
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
    margin-bottom: 34px;
  }
  .store-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
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
  }
  .store-card span {
    color: var(--muted);
    font-size: 13px;
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
    .stores {
      grid-template-columns: 1fr;
    }
  }
</style>
