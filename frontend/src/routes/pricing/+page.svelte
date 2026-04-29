<script lang="ts">
  import Footer from '$lib/components/Footer.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import { config } from '$lib/config';
</script>

<svelte:head>
  <title>Pricing — Deepmarks</title>
</svelte:head>

<a href="/" class="back"><Logo size={20} flip /> back</a>

<header class="page-header">
  <h1>pricing</h1>
  <p class="lede">no subscription. permanent bookmarks.</p>
</header>

<section class="tiers">
  <article class="tier pixel-card">
    <div class="tier-head">
      <h2>free</h2>
      <p class="amount">0 sats</p>
    </div>
    <ul>
      <li>save private + public bookmarks</li>
      <li>import old bookmarks</li>
      <li>pay-as-you-go site archives at {config.archivePriceSats} sats per page</li>
    </ul>
    <a href="/signup" class="cta">get started</a>
  </article>

  <article class="tier pixel-card accent">
    <div class="ribbon">recommended</div>
    <div class="tier-head">
      <h2>lifetime</h2>
      <p class="amount">{config.lifetimePriceSats.toLocaleString()} sats</p>
    </div>
    <ul>
      <li>unlimited site archives</li>
      <li>duplicated storage worldwide</li>
    </ul>
    <a href="/signup?tier=lifetime" class="cta">upgrade</a>
  </article>
</section>

<section class="faq">
  <h2>questions</h2>

  <details id="duplicated-worldwide">
    <summary>How is my data duplicated worldwide?</summary>
    <p>
      Public bookmarks are Nostr <code>kind:39701</code> events sent to multiple relays at once.
      Private bookmarks are encrypted with NIP-44 v2 before they leave your device. Your data
      lives on relays you control — not in our database — so the network stays useful even if
      Deepmarks disappears.
    </p>
  </details>

  <details id="archive-forever">
    <summary>How do permanent site archives work?</summary>
    <p>
      Pay {config.archivePriceSats} sats to snapshot a page forever. We render the page through
      SingleFile and mirror the resulting blob to four independent Blossom servers by default,
      with the hashes pinned in your own <code>kind:10063</code> Nostr event. If Deepmarks
      vanishes, the mirrors don't. Lifetime membership buys unlimited site archives.
    </p>
  </details>

  <details id="tip-great-links">
    <summary>How do tips (zaps) work?</summary>
    <p>
      Send a zap to great bookmarks and your wallet pays three Lightning invoices at once:
      80% to the curator who saved the link, 10% to the site operator (when their Lightning
      address is detectable), and 10% to Deepmarks. Nothing is custodial — we never hold your sats.
    </p>
  </details>

  <details id="import-export">
    <summary>How do I import and export my bookmarks?</summary>
    <p>
      Import from Pinboard, del.icio.us, Pocket, Instapaper, Raindrop, or Netscape HTML.
      Export to Netscape HTML, Pinboard JSON, CSV, or raw signed Nostr events at any time.
      There is no lock-in to leave from.
    </p>
  </details>

  <details>
    <summary>Why no subscriptions?</summary>
    <p>
      Recurring payments lock you into infrastructure decisions you didn't make. Pay once per
      archive (or once for lifetime) and you own the result. The only ongoing cost is storage
      extension at our break-even rate.
    </p>
  </details>

  <details>
    <summary>Can I see the archive before paying?</summary>
    <p>
      Yes — we render the page through SingleFile and show you the snapshot before charging the
      invoice. If the page breaks (paywall, JS-only render), you're not billed.
    </p>
  </details>

  <details id="archive-deletion">
    <summary>What happens when I delete an archive?</summary>
    <p>
      Deleting an archive from your account does three things: (1) removes it from your
      <code>/app/archives</code> list, (2) deletes the blob from Deepmarks' primary storage so
      <code>blossom.deepmarks.org/&lt;hash&gt;</code> starts returning 404, and — for private
      archives — (3) wipes the per-archive AES key from your local cache and your encrypted
      <code>kind:30003</code> archive-key set on Nostr.
    </p>
    <p>
      What we <em>can't</em> do is reach into the other Blossom mirror operators (Primal,
      Satellite CDN, hzrd149) and force them to drop their copies. They pulled the bytes
      independently when the archive was first published, and they host under their own
      retention policies. For <strong>public</strong> archives this means the snapshot is
      effectively permanent — anyone with the hash can still find a mirror that serves it.
      For <strong>private</strong> archives the ciphertext on those mirrors becomes
      mathematically unreadable as soon as you delete the key (which is what step 3 above does
      across every device you sign in with).
    </p>
    <p>
      This is the tradeoff of content-addressed, federated permanence: the same property that
      makes your archive resilient to Deepmarks shutting down also makes it resilient to <em>you</em>
      shutting down individual copies. Plan accordingly: archive privately if you want
      reversibility, archive publicly if you want indelibility.
    </p>
  </details>
</section>

<Footer />

<style>
  .page-header {
    max-width: 640px;
    margin: 0 auto;
    padding: 40px 24px 30px;
    text-align: center;
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
  h1 {
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 32px;
    font-weight: 600;
    color: var(--ink-deep);
    letter-spacing: -0.4px;
    margin: 0;
  }
  .lede {
    font-family: 'Space Grotesk', Inter, sans-serif;
    margin: 10px 0 0;
    color: var(--muted);
    font-size: 15px;
    font-weight: 500;
    letter-spacing: -0.2px;
  }
  .tiers {
    max-width: 640px;
    margin: 0 auto;
    padding: 30px 24px 60px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .tier {
    padding: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  /* lifetime-only: stand out with a persistent coral tint + double offset
     shadow on hover so it reads as the premium choice at a glance. */
  .tier.accent {
    background: var(--coral-soft);
    box-shadow: 3px 3px 0 var(--coral);
  }
  .tier.accent:hover {
    box-shadow: 5px 5px 0 var(--coral), 10px 10px 0 var(--ink-deep);
  }
  .ribbon {
    position: absolute;
    top: -12px;
    right: 16px;
    background: var(--ink-deep);
    color: var(--paper);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 2px;
    text-transform: uppercase;
    padding: 4px 10px;
    border: 2px solid var(--coral);
  }
  .tier-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 18px;
    border-bottom: 2px solid var(--ink-deep);
  }
  .tier.accent .tier-head {
    border-bottom-color: var(--coral);
    background: transparent;
  }
  .tier h2 {
    font-size: 18px;
    color: var(--ink-deep);
    margin: 0;
    text-transform: lowercase;
  }
  .amount {
    font-family: 'VT323', 'Courier New', monospace;
    font-size: 28px;
    line-height: 1;
    color: var(--coral-deep);
    margin: 0;
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
  }
  ul {
    list-style: none;
    padding: 14px 18px;
    margin: 0;
    flex: 1;
  }
  ul li {
    padding: 4px 0;
    color: var(--ink);
    font-size: 13px;
    line-height: 1.45;
  }
  ul li::before {
    content: '▸ ';
    color: var(--coral);
    font-size: 11px;
  }
  .cta {
    display: block;
    background: var(--coral);
    color: var(--on-coral) !important;
    border-top: 2px solid var(--coral-deep);
    padding: 12px 18px;
    text-align: center;
    font-weight: 600;
    text-decoration: none;
    transition: background 80ms ease-out;
  }
  .cta:hover {
    background: var(--coral-deep);
    text-decoration: none;
  }
  .faq {
    max-width: 640px;
    margin: 0 auto;
    padding: 0 24px 60px;
  }
  .faq h2 {
    font-size: 20px;
    color: var(--ink-deep);
    margin: 0 0 16px;
  }
  details {
    border-bottom: 1px solid var(--rule);
    padding: 14px 0;
  }
  details summary {
    cursor: pointer;
    color: var(--ink-deep);
    font-weight: 500;
    list-style: none;
    position: relative;
    padding-left: 22px;
  }
  details summary::-webkit-details-marker {
    display: none;
  }
  details summary::before {
    content: '+';
    color: var(--coral);
    position: absolute;
    left: 0;
    top: 0;
    width: 16px;
    text-align: left;
  }
  details[open] summary::before {
    content: '−';
  }
  details p {
    color: var(--ink);
    margin: 10px 0 0;
    padding-left: 22px;
    line-height: 1.55;
  }
  code {
    font-family: 'Courier New', monospace;
    font-size: 12px;
    background: var(--paper-warm);
    padding: 1px 5px;
    border-radius: 4px;
  }
</style>
