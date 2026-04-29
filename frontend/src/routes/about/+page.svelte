<script lang="ts">
  import Footer from '$lib/components/Footer.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import { config } from '$lib/config';
</script>

<svelte:head>
  <title>About — Deepmarks</title>
</svelte:head>

<a href="/" class="back"><Logo size={20} flip /> back</a>

<header class="page-header">
  <h1>about deepmarks</h1>
  <p class="lede">bookmarks for the open web.</p>
</header>

<section class="intro">
  <p>
    deepmarks is a slightly social bookmarking site. save a link, tag it, come back later.
    you can tip the people who find great links, and you can archive a page forever for
    500 sats. nothing you save here depends on us staying around — every bookmark is a
    signed nostr event on relays you pick, readable by any nostr client.
  </p>
  <p>
    it works like a classic social bookmarking site in spirit, but the data is yours. if we shut
    down tomorrow, your bookmarks keep working everywhere else.
  </p>
</section>

<section class="faq">
  <h2>questions</h2>

  <details>
    <summary>how do i save a bookmark?</summary>
    <p>
      sign in with a nostr signer (a browser extension like alby or nos2x, a nip-46
      bunker, or by pasting an nsec), then paste a URL in the save box at the top of
      your bookmarks page. you can add a title, description, and tags. hit save and
      it publishes to your nostr relays — we don't hold it, we just help you create it.
    </p>
  </details>

  <details>
    <summary>where does the content on the site come from?</summary>
    <p>
      two sources. one: saves made directly through deepmarks. two: public kind:39701
      bookmarks anyone on nostr has published — we subscribe to a handful of public
      relays and show what's there.
    </p>
    <p>
      the <strong>posts</strong> tab on your profile is a third source: if you bookmark
      notes or urls inside any nostr client, those land in a
      kind:10003 event on nostr and we pull them in so you can see them next to your
      deepmarks saves.
    </p>
  </details>

  <details>
    <summary>what are zaps and how do the 80/10/10 splits work?</summary>
    <p>
      a zap is a lightning tip with a public receipt on nostr. when you zap a bookmark,
      your wallet pays three invoices at once:
    </p>
    <ul>
      <li><strong>80%</strong> to the curator who saved the link (via their lud16)</li>
      <li><strong>10%</strong> to the site operator whose page was bookmarked, when a lightning
        address is detectable on that page</li>
      <li><strong>10%</strong> to deepmarks, at <code>zap@deepmarks.org</code></li>
    </ul>
    <p>
      nothing is custodial — your wallet pays all three directly. we never hold your
      sats. receipts land on the relays you choose, so any nostr client can verify the
      payment.
    </p>
  </details>

  <details>
    <summary>what if the curator doesn't have a lightning address?</summary>
    <p>
      their 80% share rolls into the deepmarks leg rather than failing the zap. the
      split box tells you this will happen before you confirm. if the site's lightning
      address isn't detectable either, the full amount goes to deepmarks and the zap
      still executes. we don't silently redirect — the dialog always shows exactly
      who's getting what.
    </p>
  </details>

  <details>
    <summary>how do you find a website's lightning address?</summary>
    <p>
      when you paste a url, we fetch the page and look for two things in the html head:
    </p>
    <ul>
      <li><code>&lt;meta name="lightning" content="you@wallet.com"&gt;</code></li>
      <li><code>&lt;link rel="lightning" href="lightning:you@wallet.com"&gt;</code></li>
    </ul>
    <p>
      either a lud16-style address or an lnurl works. if we find one, the site gets the
      10% leg automatically on every zap of that bookmark. if you run a site, adding
      one line to your <code>&lt;head&gt;</code> is enough to start receiving tips.
    </p>
  </details>

  <details>
    <summary>how do my links get on the popular list?</summary>
    <p>
      to keep noise out, a bookmark needs at least two signals to appear on the popular
      list — two saves, one save plus one zap, etc. (zaps count double since they cost
      sats). for bookmarks that come from the open nostr firehose rather than from
      deepmarks users, we additionally require more than 500 sats of zaps total. this
      filters out one-off saves by single users without blocking any genuinely endorsed
      content.
    </p>
  </details>

  <details>
    <summary>what's the difference between bookmarking and archiving?</summary>
    <p>
      bookmarking is free and always will be. archiving is paid — {config.archivePriceSats} sats
      to snapshot a page permanently. we render the page through singlefile, check the
      internet archive's wayback machine, and mirror the resulting blob to four blossom
      servers by default. if any page you care about breaks later, the archive still
      works.
    </p>
  </details>

  <details>
    <summary>what does lifetime membership get me?</summary>
    <p>
      {config.lifetimePriceSats.toLocaleString()} sats one time, pay via lightning. unlimited page
      archives after that, and api access for programmatic reads and writes. the price
      goes up a little each year past launch — there's no ongoing fee. see
      <a href="/pricing">pricing</a> for the full breakdown.
    </p>
  </details>

  <details>
    <summary>do you own my bookmarks? what happens if deepmarks shuts down?</summary>
    <p>
      your public bookmarks are kind:39701 nostr events signed by your own key and
      published to relays you choose. we're a convenience layer on top — a nice
      interface, search, the zap split, permanent archives. if we disappear, every
      bookmark you ever saved is still readable by any nostr client, because the events
      live on relays, not on our server.
    </p>
    <p>
      private bookmarks are encrypted client-side with nip-44 before they leave your
      browser. even we see only ciphertext.
    </p>
  </details>

  <details>
    <summary>do i need a nostr account to use deepmarks?</summary>
    <p>
      to browse, no — popular, recent, tags, and any user's public profile are open
      to anyone. to save your own bookmarks or zap, yes. if you have a nostr extension
      (alby, nos2x, flamingo) it's one click. you can also paste an nsec once in the
      browser, or connect a nip-46 bunker.
    </p>
  </details>

  <details>
    <summary>is deepmarks open source?</summary>
    <p>
      yes — <a href="https://github.com/ostermayer/deepmarks-public" target="_blank" rel="noreferrer">github.com/ostermayer/deepmarks-public</a>.
    </p>
  </details>
</section>

<Footer />

<style>
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
  .page-header {
    max-width: 680px;
    margin: 0 auto;
    padding: 50px 24px 24px;
    text-align: center;
  }
  .page-header h1 {
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 32px;
    letter-spacing: -0.5px;
    color: var(--ink-deep);
    margin: 0 0 8px;
    font-weight: 600;
  }
  .lede {
    color: var(--muted);
    font-size: 15px;
    margin: 0;
  }
  .intro {
    max-width: 680px;
    margin: 0 auto;
    padding: 20px 24px 0;
    color: var(--ink);
    line-height: 1.7;
    font-size: 15px;
  }
  .intro p {
    margin: 0 0 16px;
  }
  .faq {
    max-width: 680px;
    margin: 20px auto 60px;
    padding: 0 24px;
  }
  .faq h2 {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--muted);
    letter-spacing: 1.5px;
    margin: 0 0 16px;
    padding-bottom: 8px;
    border-bottom: 2px solid var(--ink-deep);
    font-weight: 600;
  }
  details {
    border-bottom: 1px solid var(--rule);
    padding: 14px 0;
  }
  details[open] {
    padding-bottom: 18px;
  }
  summary {
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 16px;
    font-weight: 600;
    color: var(--ink-deep);
    cursor: pointer;
    list-style: none;
    position: relative;
    padding-right: 24px;
    letter-spacing: -0.2px;
  }
  summary::-webkit-details-marker { display: none; }
  summary::after {
    content: '+';
    position: absolute;
    right: 0;
    top: -2px;
    color: var(--muted);
    font-weight: 400;
    transition: transform 0.15s;
    font-size: 20px;
  }
  details[open] summary::after {
    content: '−';
  }
  summary:hover {
    color: var(--coral);
  }
  details p {
    margin: 12px 0 0;
    color: var(--ink);
    line-height: 1.65;
    font-size: 14px;
  }
  details ul {
    margin: 12px 0 0;
    padding-left: 18px;
    color: var(--ink);
    font-size: 14px;
    line-height: 1.65;
  }
  details ul li {
    margin-bottom: 4px;
  }
  code {
    font-family: 'Courier New', monospace;
    font-size: 12px;
    background: var(--paper-warm);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--ink-deep);
  }
  a {
    color: var(--link);
  }
</style>
