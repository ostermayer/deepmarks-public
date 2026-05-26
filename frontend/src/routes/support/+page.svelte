<script lang="ts">
  import Footer from '$lib/components/Footer.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import ProtectedEmail from '$lib/components/ProtectedEmail.svelte';
  import { APP_VERSION } from '$lib/version';
</script>

<svelte:head>
  <title>Support - Deepmarks</title>
  <meta
    name="description"
    content="Deepmarks support page. Get help with the web app, browser extensions, iOS app, Android app, bookmarks, archives, and account access."
  />
</svelte:head>

<a href="/" class="back"><Logo size={20} flip /> back</a>

<main class="support-page">
  <header class="page-header">
    <h1>support</h1>
    <p class="lede">help with Deepmarks, bookmarks, archives, and mobile apps.</p>
  </header>

  <section class="support-card">
    <h2>contact</h2>
    <p>
      Email <ProtectedEmail subject="Deepmarks support request" /> for app support,
      account help, billing questions, bug reports, or takedown requests.
    </p>
    <p class="muted">
      Include your npub, device or browser, app version if available, and a short
      description of what happened.
    </p>
  </section>

  <section class="support-card">
    <h2>quick links</h2>
    <ul>
      <li><a href="/privacy">Privacy policy</a></li>
      <li><a href="/about">About Deepmarks</a></li>
      <li><a href="/api">API documentation</a></li>
      <li><a href="https://github.com/ostermayer/deepmarks-public" target="_blank" rel="noreferrer">Source code</a></li>
    </ul>
  </section>

  <section class="support-card">
    <h2>current app version</h2>
    <p>Deepmarks web/mobile bundle: <span class="version">v{APP_VERSION}</span></p>
  </section>
</main>

<Footer />

<style>
  .back {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 16px 24px;
    font-size: 13px;
    color: var(--muted);
    text-decoration: none;
  }
  .back:hover {
    color: var(--coral);
  }
  .support-page {
    width: min(760px, calc(100% - 48px));
    margin: 0 auto;
    padding: 24px 0 52px;
  }
  .page-header {
    border-bottom: 1px solid var(--rule);
    padding-bottom: 20px;
    margin-bottom: 24px;
  }
  h1 {
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 38px;
    color: var(--ink-deep);
    margin: 0 0 8px;
    font-weight: 600;
    letter-spacing: 0;
  }
  .lede {
    color: var(--muted);
    font-size: 15px;
    margin: 0;
  }
  .support-card {
    border-bottom: 1px solid var(--rule);
    padding: 22px 0;
  }
  h2 {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--muted);
    margin: 0 0 10px;
  }
  p {
    margin: 0 0 10px;
    color: var(--ink);
    line-height: 1.7;
    font-size: 15px;
  }
  .muted {
    color: var(--muted);
  }
  ul {
    margin: 0;
    padding-left: 20px;
    line-height: 1.8;
  }
  a {
    color: var(--link);
  }
  a:hover {
    color: var(--coral);
  }
  .version {
    font-family: 'Courier New', monospace;
    color: var(--ink-deep);
  }
  @media (max-width: 640px) {
    .support-page {
      width: min(100% - 32px, 760px);
      padding-top: 12px;
    }
    h1 {
      font-size: 32px;
    }
  }
</style>
