<script lang="ts">
  import Footer from '$lib/components/Footer.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import ProtectedEmail from '$lib/components/ProtectedEmail.svelte';
</script>

<svelte:head>
  <title>Privacy — Deepmarks</title>
  <meta
    name="description"
    content="Deepmarks privacy policy. No tracking, no ads, no analytics, and only the minimum operational data needed to run the service."
  />
</svelte:head>

<a href="/" class="back"><Logo size={20} flip /> back</a>

<header class="page-header">
  <h1>privacy</h1>
  <p class="lede">no tracking, no ads, no analytics, and no sale of user data.</p>
</header>

<section class="body">
  <p class="updated">Last updated: 2026-05-20</p>

  <h2>the short version</h2>
  <p>
    Deepmarks is designed to collect as little data as possible. We do not use
    analytics, tracking pixels, advertising SDKs, cross-site trackers, or data
    brokers. We do not sell user data. We do not build behavioral profiles.
  </p>
  <p>
    Deepmarks does handle the information required to make the product work:
    your public Nostr identifier, the bookmarks and posts you choose to save,
    account settings, archive records, payment entitlement records, and push
    notification tokens if you opt in. Private keys are generated or stored on
    your device, or stored only as client-side encrypted backup ciphertext when
    you choose a passkey-backed account.
  </p>

  <h2>what deepmarks handles</h2>
  <ul>
    <li>
      <strong>your Nostr public key</strong> — used as your account identifier
      and to sync your settings, relays, profile, contact list, bookmarks,
      posts, zaps, and archive entitlement.
    </li>
    <li>
      <strong>bookmarks and posts</strong> — public bookmarks and kind:1 posts
      are signed Nostr events and may be visible on Nostr relays. Private
      bookmarks are encrypted client-side before being published or stored.
    </li>
    <li>
      <strong>account settings</strong> — settings such as default visibility,
      default tags, relay preferences, theme, archive defaults, and add-on
      state are stored so they sync across web, browser extensions, iOS, and
      Android.
    </li>
    <li>
      <strong>archives</strong> — when you archive a page, our worker fetches
      the page, creates the archive, and stores the archive metadata needed to
      show it in your account. Private archive content is not made public.
      Media archive add-on content is private and not redistributed publicly.
      If you enable the browser extension's current-view fallback, the
      extension sends the captured HTML for that tab as an encrypted private
      archive.
    </li>
    <li>
      <strong>payments and entitlements</strong> — lifetime membership and
      add-on payments are processed through BTCPay. We store the payment
      identifier, status, amount, purchase type, and Nostr public key being
      credited so the feature keeps working after payment.
    </li>
    <li>
      <strong>push notification tokens</strong> — if you opt in to push
      notifications, we store the browser push subscription or native device
      token needed to deliver notifications. Turning push off removes that
      subscription from Deepmarks.
    </li>
    <li>
      <strong>short usernames</strong> — if you claim a handle like
      <code>/u/dan</code>, we store the mapping between that handle and your
      public key so the URL resolves.
    </li>
  </ul>

  <h2>what we do not collect</h2>
  <ul>
    <li>no analytics, tracking pixels, third-party trackers, or advertising SDKs</li>
    <li>no sale of user data and no sharing with advertisers</li>
    <li>no behavioral profiles and no cross-site browsing history</li>
    <li>no credit card or bank information</li>
    <li>no contacts upload from your device address book</li>
    <li>no location tracking</li>
    <li>no microphone, photo library, or health data access</li>
    <li>camera access only when you explicitly scan a QR code; the video stays on device and is not uploaded</li>
  </ul>

  <h2>private keys</h2>
  <p>
    Your Nostr private key is the key to your account. Deepmarks is built so
    the server does not need your raw private key.
  </p>
  <ul>
    <li>
      On iOS and Android, the key is stored in the device secure storage layer
      when you create or import a local key.
    </li>
    <li>
      In the browser extension, the key is stored locally by the extension and
      encrypted with the password you set.
    </li>
    <li>
      When you use an external NIP-07 signer, Deepmarks never sees the key.
    </li>
    <li>
      When you use a passkey-backed account, Deepmarks stores only encrypted
      ciphertext. Encryption and decryption happen client-side.
    </li>
  </ul>

  <h2>browser extensions and mobile apps</h2>
  <p>
    The browser extensions and mobile apps follow the same privacy model as
    the website. They sign locally, save locally where possible, and send only
    the information needed to publish, sync, archive, pay, or notify.
  </p>
  <p>
    The browser extension reads the active tab's title, URL, and description
    only when you click save. It does not track every page you visit.
  </p>

  <h2>third parties</h2>
  <ul>
    <li>
      <strong>Nostr relays</strong> — public Nostr events are sent to
      relay.deepmarks.org and, depending on your settings, to the relays in
      your Nostr relay list. Public events on Nostr should be treated as public.
    </li>
    <li>
      <strong>Blossom storage</strong> — archive blobs are stored on
      Deepmarks-hosted Blossom storage and may be mirrored for redundancy.
    </li>
    <li>
      <strong>BTCPay and Lightning</strong> — payments use BTCPay and Bitcoin
      Lightning. Deepmarks records only what is needed to credit the purchase.
    </li>
    <li>
      <strong>Push services</strong> — if you enable notifications, delivery
      depends on the platform push service used by your browser or device,
      such as Apple Push Notification service, Firebase Cloud Messaging, or
      Mozilla Autopush.
    </li>
  </ul>
  <p>
    We do not use Google Analytics, Meta Pixel, Hotjar, Mixpanel, Segment, or
    similar products. We do not embed third-party scripts for tracking.
  </p>

  <h2>server logs</h2>
  <p>
    Like any internet service, our servers may briefly process technical
    connection information such as IP address, user agent, timestamp, request
    path, and error details. We use this for security, abuse prevention, and
    operations. We do not use server logs for advertising or profiling.
  </p>

  <h2>your controls</h2>
  <ul>
    <li>
      <strong>Delete bookmarks</strong> — Deepmarks can publish Nostr deletion
      events for supported bookmark types. Relay deletion behavior depends on
      the relay.
    </li>
    <li>
      <strong>Delete your account data</strong> — the app includes account
      deletion controls for Deepmarks-hosted settings, private marks,
      archives, passkeys, encrypted backups, usernames, and API keys.
    </li>
    <li>
      <strong>Turn off push</strong> — disable push notifications in settings
      to remove the stored push subscription.
    </li>
    <li>
      <strong>Take your data elsewhere</strong> — Deepmarks uses Nostr events
      where possible, so public bookmarks and posts can be read by other Nostr
      clients and relays.
    </li>
    <li>
      <strong>Read the code</strong> — the frontend, browser extension,
      archive worker, and payment proxy are open source at
      <a href="https://github.com/ostermayer/deepmarks-public" target="_blank" rel="noreferrer">github.com/ostermayer/deepmarks-public</a>.
    </li>
  </ul>

  <h2>children</h2>
  <p>
    Deepmarks is not directed at children under 13.
  </p>

  <h2>changes</h2>
  <p>
    If we change anything material on this page, we will update the date above.
    The canonical version of this policy is the version published at this URL.
  </p>

  <h2>contact</h2>
  <p>
    Questions, privacy requests, or takedown requests:
    <ProtectedEmail subject="Deepmarks privacy request" />.
  </p>
</section>

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
  .page-header {
    text-align: center;
    padding: 32px 24px 24px;
    border-bottom: 1px solid var(--rule);
    margin: 0 auto;
    max-width: 680px;
  }
  .page-header h1 {
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 36px;
    color: var(--ink-deep);
    letter-spacing: -0.6px;
    margin: 0 0 8px;
    font-weight: 600;
  }
  .lede {
    color: var(--muted);
    font-size: 15px;
    margin: 0;
  }
  .body {
    max-width: 680px;
    margin: 0 auto;
    padding: 24px 24px 60px;
    color: var(--ink);
    line-height: 1.7;
    font-size: 15px;
  }
  .updated {
    color: var(--muted);
    font-size: 12px;
    margin: 0 0 24px;
    font-family: 'Courier New', monospace;
  }
  .body h2 {
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 13px;
    text-transform: uppercase;
    color: var(--muted);
    letter-spacing: 1.5px;
    margin: 32px 0 12px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--rule);
    font-weight: 600;
  }
  .body p {
    margin: 0 0 14px;
  }
  .body ul {
    margin: 0 0 18px;
    padding-left: 22px;
  }
  .body li {
    margin-bottom: 8px;
  }
  .body strong {
    color: var(--ink-deep);
  }
  .body code {
    font-family: 'Courier New', monospace;
    font-size: 13px;
    background: var(--surface);
    padding: 1px 6px;
    border-radius: 4px;
    color: var(--ink-deep);
  }
  .body a {
    color: var(--link);
  }
  .body a:hover {
    color: var(--coral);
  }
</style>
