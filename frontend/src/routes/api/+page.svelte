<script lang="ts">
  // Public API documentation page.
  //
  // Audience is people who want to script Deepmarks: search their own
  // bookmarks, search everyone's, add bookmarks, request deletions,
  // list their archives. Internal endpoints (passkey enrollment,
  // ciphertext storage, admin moderation, BTCPay webhook) are
  // intentionally NOT documented here — those are wire details for
  // first-party clients, not user-facing surface.

  import Footer from '$lib/components/Footer.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import { config } from '$lib/config';
</script>

<svelte:head>
  <title>API — Deepmarks</title>
  <meta
    name="description"
    content="Search and add Deepmarks bookmarks from your own scripts. Mint a Bearer key in /app/settings (lifetime tier) and call api.deepmarks.org/api/v1/* — full-text search, multi-tag filter, add/delete bookmarks, list your archives. Public bookmarks are also readable directly from any Nostr relay (no key needed)."
  />
</svelte:head>

<a href="/" class="back"><Logo size={20} flip /> back</a>

<header class="page-header">
  <h1>deepmarks API</h1>
  <p class="lede">
    a small REST surface for scripting Deepmarks. mint a Bearer key, then search,
    add, delete, and list your bookmarks + archives. <strong>private bookmarks are
    never exposed</strong> — they're encrypted client-side and the API has no way
    to decrypt them.
  </p>
</header>

<section>
  <h2>1. Two ways in</h2>

  <h3>A. Just want to read public bookmarks?</h3>
  <p>
    No signup, no key. Public bookmarks are <code>kind:39701</code> (NIP-B0)
    Nostr events — connect to <code>wss://relay.deepmarks.org</code> (or any of
    our default relays) and subscribe. Full event shape is at the bottom of
    this page.
  </p>

  <h3>B. Want to script your own bookmarks?</h3>
  <p>
    Mint a Bearer key from <a href="/app/settings">/app/settings</a> →
    <em>API keys</em>. <strong>Requires the lifetime tier</strong>
    ({config.lifetimePriceSats.toLocaleString()} sats, one-time).
    Use the key as <code>Authorization: Bearer dmk_live_…</code> on every
    <code>/api/v1/*</code> call below.
  </p>
  <p class="callout">
    The plaintext key is shown once, at creation. Save it immediately — there
    is no recovery path. Compromised key? Revoke it from the same settings
    page; the underlying nsec is unaffected.
  </p>
</section>

<section>
  <h2>2. Endpoints</h2>
  <p>Base URL: <code>{config.apiBase}</code></p>

  <h3>Search your own bookmarks</h3>
<pre><code>GET /api/v1/bookmarks?q=rust&tag=async&tag=tokio&limit=50</code></pre>
  <p>
    Full-text search across <code>title</code> + <code>description</code>,
    plus <code>tag</code> filters (repeat for AND). Empty <code>q</code> +
    no tags returns the most recent — straight from your relays. Paginate
    with <code>offset</code>.
  </p>
  <ul>
    <li><code>q</code> — search text (optional)</li>
    <li><code>tag</code> — repeatable, AND-combined</li>
    <li><code>limit</code> — 1–500, default 200</li>
    <li><code>offset</code> — 0–10 000</li>
    <li><code>archived=true</code> — only bookmarks with the forever-archive flag (simple-list mode only)</li>
  </ul>
  <p class="footnote">
    Returns <code>&#123; bookmarks: [...], count, mode &#125;</code>. <code>mode</code> is
    <code>"search"</code> (Meilisearch — supports q, multi-tag, offset) or
    <code>"list"</code> (relay subscription — fresher, supports the
    <code>archived</code> filter).
  </p>

  <h3>Search public bookmarks (everyone's)</h3>
<pre><code>GET /api/v1/search/public?q=bitcoin&tag=lightning&author=&lt;hex&gt;&site=stacker.news</code></pre>
  <p>
    Same query language as the search box on the public site. Always
    returns <code>kind:39701</code> only — private content has no
    representation in the index.
  </p>
  <ul>
    <li><code>q</code> — search text</li>
    <li><code>tag</code> — repeatable, AND-combined</li>
    <li><code>author</code> — hex pubkey (optional, scope to one curator)</li>
    <li><code>site</code> — domain filter, e.g. <code>github.com</code></li>
    <li><code>limit</code> — 1–100, default 50</li>
    <li><code>offset</code> — 0–10 000</li>
  </ul>

  <h3>Add a bookmark</h3>
<pre><code>POST /api/v1/bookmarks
Authorization: Bearer dmk_live_…
Content-Type: application/json

&#123;
  "id": "&lt;event id&gt;",
  "pubkey": "&lt;your pubkey hex&gt;",
  "kind": 39701,
  "created_at": 1700000000,
  "tags": [
    ["d", "https://example.com/article"],
    ["title", "the article's title"],
    ["description", "optional summary"],
    ["t", "tag1"], ["t", "tag2"]
  ],
  "content": "",
  "sig": "&lt;your signature&gt;"
&#125;</code></pre>
  <p>
    Body must be a fully-signed kind:39701 event. The server verifies the
    signature, checks <code>pubkey</code> matches the API key owner, and
    relays the event to our indexer. <code>created_at</code> can't be more
    than 10 minutes in the future. The <code>d</code> tag must be a
    public <code>http(s)</code> URL.
  </p>
  <p class="footnote">
    The signing happens in your script — the server never sees your nsec.
    See "Signing in 30 seconds" below.
  </p>

  <h3>Delete a bookmark</h3>
<pre><code>DELETE /api/v1/bookmarks/:eventId
Authorization: Bearer dmk_live_…
Content-Type: application/json

&#123;
  "id": "...",
  "pubkey": "&lt;your pubkey hex&gt;",
  "kind": 5,
  "created_at": 1700000000,
  "tags": [["e", "&lt;eventId from path&gt;"]],
  "content": "",
  "sig": "..."
&#125;</code></pre>
  <p>
    Body must be a fully-signed NIP-09 (kind:5) deletion request that
    references the event id from the URL path. Same pubkey-match rule as
    add. Relays may or may not honor deletion requests; this endpoint
    publishes the request — it can't guarantee universal removal.
  </p>

  <h3>Initiate an archive</h3>
<pre><code>POST /api/v1/archives
Authorization: Bearer dmk_live_…
Content-Type: application/json

&#123;
  "url": "https://example.com/article"
&#125;</code></pre>
  <p>
    Returns a BOLT-11 invoice for {config.archivePriceSats} sats. Pay it with
    any wallet. The archive worker renders + stores the page on Blossom on
    settlement. Lifetime members can also use <code>/archive/lifetime</code>
    (NIP-98 auth) to skip the invoice; that path isn't part of <code>/api/v1</code>.
  </p>

  <h3>Poll an archive job</h3>
<pre><code>GET /api/v1/archives/:jobId</code></pre>
  <p>
    State is <code>pending</code> → <code>paid</code> → <code>enqueued</code>
    → terminal (the archive lands in your archives list). Returns 404 for
    job ids that don't belong to your pubkey.
  </p>

  <h3>List your shipped archives</h3>
<pre><code>GET /api/v1/archives?limit=100&offset=0</code></pre>
  <p>
    Returns archives that have completed (the worker callback finalized
    them). Sorted newest first. Includes the <code>blobHash</code> you'd
    fetch from any Blossom server hosting it.
  </p>

  <h3>Manage your API keys</h3>
  <table>
    <thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Purpose</th></tr></thead>
    <tbody>
      <tr><td>POST</td><td><code>/api/v1/keys</code></td><td>NIP-98 + lifetime</td><td>Mint a key. Plaintext returned once.</td></tr>
      <tr><td>GET</td><td><code>/api/v1/keys</code></td><td>NIP-98</td><td>List your keys (metadata only — no plaintext).</td></tr>
      <tr><td>DELETE</td><td><code>/api/v1/keys/:id</code></td><td>NIP-98</td><td>Revoke a key.</td></tr>
    </tbody>
  </table>
  <p class="footnote">
    Key management uses NIP-98 (your nsec) instead of Bearer auth so a
    leaked key can't mint more keys for itself. See "Signing in 30 seconds"
    below.
  </p>
</section>

<section>
  <h2>3. Privacy — what's never exposed</h2>
  <ul>
    <li>
      <strong>Private bookmarks</strong> — kept in NIP-51 (<code>kind:30003</code>)
      sets encrypted to your own pubkey via NIP-44 v2. The server stores
      ciphertext only and the API has no decrypt path. You won't see
      private bookmarks in any <code>/api/v1</code> response.
    </li>
    <li>
      <strong>Other users' private bookmarks</strong> — same. Even
      <code>/api/v1/search/public</code> only indexes <code>kind:39701</code>.
    </li>
    <li>
      <strong>Your nsec</strong> — never sent to the API. Signing happens in
      your script.
    </li>
    <li>
      <strong>Email addresses</strong> — only stored as a salted hash for
      account recovery. Not exposed anywhere under <code>/api/v1</code>.
    </li>
  </ul>
</section>

<section>
  <h2>4. Signing in 30 seconds</h2>
  <p>
    Two flows you'll use: <strong>Bearer key</strong> for everyday calls,
    <strong>NIP-98</strong> for key management + the publish/delete bodies
    (which are pre-signed Nostr events).
  </p>

  <h3>Bearer</h3>
<pre><code>curl https://api.deepmarks.org/api/v1/bookmarks?q=rust \
  -H "Authorization: Bearer dmk_live_xxxxx"</code></pre>

  <h3>NIP-98 (for /api/v1/keys + signed-body publish/delete)</h3>
  <p>
    Sign a <code>kind:27235</code> event scoped to the exact URL + method.
    Body-bearing routes also need a <code>payload</code> tag with
    <code>sha256(body)</code> in hex.
  </p>
<pre><code>&#123;
  "kind": 27235,
  "created_at": 1700000000,
  "tags": [
    ["u", "https://api.deepmarks.org/api/v1/keys"],
    ["method", "POST"],
    ["payload", "&lt;sha256(body) hex, body-bearing routes only&gt;"]
  ],
  "content": "",
  "pubkey": "...", "id": "...", "sig": "..."
&#125;</code></pre>
  <p>
    Base64-encode the JSON and pass as <code>Authorization: Nostr &lt;base64&gt;</code>.
    Server rejects: stale (&gt;60s skew), wrong <code>u</code>/<code>method</code>,
    payload mismatch, or replay (event ids deduped for 65s).
  </p>
</section>

<section>
  <h2>5. Bookmark event shape (kind:39701)</h2>
  <p>
    What you publish (or what you'll find when subscribing to a relay
    directly):
  </p>
<pre><code>&#123;
  "kind": 39701,
  "tags": [
    ["d", "https://example.com/article"],
    ["title", "the article's title"],
    ["description", "optional summary"],
    ["t", "tag1"], ["t", "tag2"],
    ["blossom", "&lt;sha256-hex&gt;"],         // optional — set by archive worker
    ["archive-tier", "forever"]            // optional — set when archived
  ],
  "content": "",
  "pubkey": "...",
  "created_at": ...,
  "id": "...",
  "sig": "..."
&#125;</code></pre>

  <h3>Default relays</h3>
  <ul class="mono">
    <li>wss://relay.deepmarks.org</li>
    <li>wss://relay.damus.io</li>
    <li>wss://nos.lol</li>
    <li>wss://relay.primal.net</li>
  </ul>
  <p>
    Users override via NIP-65 (<code>kind:10002</code>); both the web app
    and the browser extension respect that list.
  </p>
</section>

<section>
  <h2>6. Limits</h2>
  <ul>
    <li><code>POST /api/v1/keys</code> — 5 per pubkey per hour</li>
    <li><code>GET /api/v1/bookmarks</code> (search mode) — 60 per pubkey per minute</li>
    <li><code>GET /api/v1/search/public</code> — 60 per pubkey per minute</li>
    <li><code>POST /api/v1/archives</code> — 10 per pubkey per minute, 30 per key per minute</li>
    <li>Bookmark <code>created_at</code> — must not be more than 10 min in the future</li>
    <li>Bookmark URLs — http(s) only</li>
  </ul>
  <p>
    429 responses include a <code>Retry-After</code> header in seconds.
  </p>
</section>

<section>
  <h2>7. Reference clients</h2>
  <ul>
    <li>
      <strong>web app</strong> — <a href="https://github.com/ostermayer/deepmarks/tree/main/frontend">frontend/</a>
      (SvelteKit). The reference for kind:39701 publish/parse + NIP-98
      lives in <code>frontend/src/lib/nostr/</code> and <code>frontend/src/lib/api/</code>.
    </li>
    <li>
      <strong>browser extension</strong> — <a href="https://github.com/ostermayer/deepmarks/tree/main/browser-extension">browser-extension/</a>
      (MV3 + React + Vite). Same kind:39701 shape; talks to relays + the
      same REST endpoints; ships a NIP-07 signer as a side-effect.
    </li>
  </ul>
</section>

<Footer />

<style>
  :global(body) { background: var(--paper); }
  .back {
    display: inline-flex; align-items: center; gap: 8px;
    margin: 24px 24px 0; color: var(--muted) !important;
    font-size: 12px; text-decoration: none;
  }
  .back:hover { color: var(--coral) !important; }
  .page-header { max-width: 720px; margin: 32px auto 0; padding: 0 24px; }
  .page-header h1 { font-family: 'Space Grotesk', Inter, sans-serif; font-size: 36px; color: var(--ink-deep); margin: 0; letter-spacing: -0.5px; }
  .lede { color: var(--ink); font-size: 16px; line-height: 1.55; margin: 12px 0 32px; }
  section { max-width: 720px; margin: 0 auto; padding: 0 24px 32px; }
  h2 { font-family: 'Space Grotesk', Inter, sans-serif; font-size: 22px; color: var(--ink-deep); margin: 32px 0 12px; }
  h3 { font-size: 14px; color: var(--ink-deep); margin: 20px 0 8px; font-weight: 600; }
  p { color: var(--ink); line-height: 1.6; margin: 0 0 12px; }
  .footnote { font-size: 13px; color: var(--muted); }
  .callout {
    background: var(--paper-warm); border-left: 3px solid var(--coral);
    padding: 10px 14px; margin: 8px 0 16px; font-size: 13px;
  }
  code { font-family: 'Courier New', monospace; font-size: 0.92em; color: var(--ink-deep); background: var(--paper-warm); padding: 1px 5px; border-radius: 3px; }
  pre {
    background: var(--paper-warm); border: 1px solid var(--rule);
    border-radius: 6px; padding: 14px 16px; overflow-x: auto; margin: 0 0 16px;
  }
  pre code { background: none; padding: 0; font-size: 12px; line-height: 1.55; }
  ul { margin: 0 0 12px; padding-left: 20px; color: var(--ink); }
  ul li { line-height: 1.55; margin-bottom: 4px; }
  ul.mono { padding-left: 0; list-style: none; font-family: 'Courier New', monospace; font-size: 12px; }
  ul.mono li { color: var(--ink-deep); }
  table { width: 100%; border-collapse: collapse; margin: 0 0 12px; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--rule); vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted); font-weight: 600; }
</style>
