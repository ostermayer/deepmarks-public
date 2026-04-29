# Deepmarks browser extension

Save bookmarks to Nostr from any tab. Cross-browser MV3 extension —
ships to **Chrome / Edge / Brave / Arc**, **Firefox**, and
**Safari (macOS + iOS)** from the same `src/` tree.

## What's in this folder

```
browser-extension/
├── design_handoff_deepmarks_extension/   # ← read-only design spec (don't edit)
├── src/
│   ├── popup/         # 9 screens + tiny in-memory router
│   │   ├── App.tsx
│   │   ├── router.ts
│   │   ├── components/
│   │   │   ├── BackButton.tsx
│   │   │   └── TagInput.tsx
│   │   └── screens/
│   │       ├── Onboarding.tsx     # first-run welcome
│   │       ├── Login.tsx          # paste nsec OR generate one in-extension
│   │       ├── SetPassword.tsx    # optional password to encrypt the nsec on disk
│   │       ├── Unlock.tsx         # password prompt for encrypted accounts
│   │       ├── Recent.tsx         # default landing — your bookmark feed
│   │       ├── Add.tsx            # save current tab (private/public toggle)
│   │       ├── Saved.tsx          # post-save confirmation + archive flow
│   │       ├── SignRequest.tsx    # NIP-07 approval for any web page
│   │       └── Settings.tsx       # security, relays, tags, archive defaults
│   ├── background/    # service worker (NIP-07 bridge, ⌘D handler)
│   ├── content-scripts/   # NIP-07 provider + page-metadata scrape
│   ├── lib/
│   │   ├── nsec-store.ts          # plaintext OR password-encrypted nsec
│   │   ├── nsec-crypto.ts         # PBKDF2-SHA256 (600k) + AES-GCM-256
│   │   ├── settings-store.ts      # relays, tags, NIP-07 grants
│   │   ├── nostr.ts               # publish kind:39701 + read feed
│   │   ├── private-bookmarks.ts   # NIP-51 kind:30003 + NIP-44 v2 self-encrypt
│   │   ├── nip98.ts               # build NIP-98 auth headers
│   │   ├── archive.ts             # /archive/purchase + /archive/lifetime + status poll
│   │   └── active-tab.ts          # read URL + title + og:description from active tab
│   └── shared/        # design tokens, Pennant brand mark
├── public/            # static assets (pennant.svg → toolbar icon, PNG variants)
├── manifest.config.ts # MV3 manifest factory (chrome / firefox)
├── vite.config.ts     # @crxjs/vite-plugin
├── safari/            # Xcode wrap (macOS + iOS Safari)
├── SECURITY.md        # threat model + nsec storage modes
└── README.md          # this file
```

## Build & load (local dev)

```bash
npm install

# Chrome / Edge / Brave / Arc
npm run build:chrome
# → dist/  (load unpacked at chrome://extensions, dev mode on)

# Firefox
npm run build:firefox
# → dist/  (load via about:debugging → "This Firefox" → Load Temporary Add-on,
#           pick dist/manifest.json)

# Safari (macOS + iOS) — see safari/README.md for the Xcode wrap step
npm run build:chrome   # Safari uses the same MV3 bundle
cd safari && cat README.md   # follow the safari-web-extension-converter steps
```

Distribution-ready zips:

```bash
npm run package:chrome   # → deepmarks-chrome.zip
npm run package:firefox  # → deepmarks-firefox.zip
# Safari ships through Xcode → App Store Connect, not zips
```

Watch mode (HMR for the popup, manual reload for content scripts / SW):

```bash
npm run dev
```

## Architecture

### Storage

All state lives in `chrome.storage.local` via two facades:

- **`lib/nsec-store.ts`** — single getter/setter/clear for the user's
  private key. Versioned schema. Two record shapes:
  - `PlainAccount` — nsec stored in cleartext. Default. Same posture
    as `nos2x` and other Nostr extensions.
  - `EncryptedAccount` — nsec stored as AES-GCM-256 ciphertext, key
    derived from the user's password via PBKDF2-SHA256 (600 000
    iterations, 16-byte random salt). The derived key is cached in
    `chrome.storage.session` (cleared on browser close) or — when
    the user picks "remember 30 days" — also mirrored to
    `chrome.storage.local` with a TTL timestamp.

  See `SECURITY.md` for the full threat model.

- **`lib/settings-store.ts`** — relays, default tags, archive
  preferences, default visibility (private/public), saved NIP-07
  logins (forever-grants). Every mutating write goes through a
  single-flight chain so popup + background can't lost-update each
  other on the `savedLogins` array.

### What's pure Nostr, what hits our API

Almost everything is **pure Nostr** — the extension talks to relays
directly via WebSocket using `nostr-tools`'s `SimplePool`. No
Deepmarks-specific server is involved in:

- Saving a public bookmark (`kind:39701` published to user's write relays)
- Saving a private bookmark (`kind:30003` NIP-51 set, NIP-44 v2 encrypted to self)
- Reading saved bookmarks (subscribe to user's read relays)
- Acting as a NIP-07 signer for any third-party Nostr site

The **only** things that hit `api.deepmarks.org`:

| Endpoint | When |
|---|---|
| `GET /account/lifetime/status?pubkey=…` | Check if user is a lifetime member (decides which archive route + gates the "archive new bookmarks by default" toggle) |
| `POST /account/lifetime` (NIP-98) | Mint a BTCPay invoice to upgrade to lifetime (shown inline when a free user toggles on archive-default) |
| `POST /archive/lifetime` (NIP-98) | Free archive for lifetime members |
| `POST /archive/purchase` (NIP-98) | Paid archive — returns BOLT-11 invoice |
| `GET /archive/status/:paymentHash` | Poll archive job state |

### Bookmark event shape

`kind:39701` matches what `frontend/src/lib/nostr/bookmarks.ts`
parses, so a bookmark saved from the extension renders in the web
app feed unchanged:

```ts
{
  kind: 39701,
  tags: [
    ['d', url],                    // parameterized-replaceable id
    ['title', title],
    ['description', description],  // optional
    ['t', tag1], ['t', tag2], …
    ['blossom', hash],             // when archived
    ['archive-tier', 'forever'],   // when archived
  ],
  content: '',
}
```

URLs are validated as `http(s)` only via `assertSafeBookmarkUrl` before
signing — `javascript:`/`data:`/`file:` URLs never reach relays.

### Private bookmarks

Toggled per-bookmark on the Add screen (default visibility set in
Settings). Routed through `lib/private-bookmarks.ts`:

1. Fetch the user's existing kind:30003 set with `d=deepmarks-private`.
2. Decrypt content with NIP-44 v2 using `getConversationKey(nsec, ownPubkey)`.
3. De-dup by URL d-tag, append the new entry.
4. Re-encrypt + sign + publish the whole set as a kind:30003 replacement.

The web app (`frontend/src/lib/nostr/private-bookmarks.ts`) uses the
same shape, so a private bookmark saved here shows up in the web
app's private feed unchanged.

### NIP-07 signer

The extension defines `window.nostr` at `document_start` on every
`https://*` page. Two content scripts split the work:

- `content-scripts/nip07-provider.ts` runs in the page's **MAIN
  world** (Chrome 111+ / Firefox 128+) and assigns `window.nostr`
  directly. No inline `<script>` injection, so strict-CSP pages
  (Gmail, Google Chat, GitHub, X) work cleanly.
- `content-scripts/nip07-bridge.ts` runs in the standard
  **ISOLATED world**, listens for `window.postMessage` from the
  provider, and forwards to `chrome.runtime.sendMessage`.

Calls proxy through `chrome.runtime` to the background service worker,
which gates each request on:

- **Cached origin grant?** Five tiers: `just-once`, `until-close`,
  `one-hour`, `forever` (persisted in `savedLogins`), or no grant →
  prompt the user via the SignRequest screen.
- **Always-prompt kinds.** Even on a cached grant, these kinds force
  a fresh prompt: `kind:0` (profile rewrite), `kind:3` (contacts),
  `kind:5` (deletion), `kind:13` (sealed DM), `kind:1059` (gift
  wrap), `kind:10002` (relay list). Approving a low-stakes kind once
  doesn't transitively bless rewriting your profile or deleting all
  your events.
- **Pending request bounding.** The service worker caps in-flight
  approvals at 50 entries and evicts anything older than 5 minutes.
  A malicious page can't OOM the worker by spamming signEvent calls.
- **Body validation.** The page-supplied event template is shape-checked
  (kind is integer 0–65535, tags is `string[][]`, content is string)
  before `finalizeEvent` to stop malformed events from producing
  corrupt signed bytes on relays.

`window.postMessage` between page and content script pins
`targetOrigin` to `window.location.origin` (not `'*'`) so a
mid-call navigation can't leak nip04/nip44 plaintext into a foreign
document. Page-side promises also have a 60 s hard timeout so
service-worker restarts don't leave the page hanging forever.

## Distribution

| Browser | Where to publish |
|---|---|
| Chrome / Edge | Chrome Web Store + Edge Add-ons (same zip works for both, separate listings) |
| Brave / Arc | Inherits from Chrome Web Store automatically |
| Firefox | addons.mozilla.org (signed `.xpi`) |
| Safari macOS | Mac App Store via Xcode (see `safari/`) |
| Safari iOS | App Store via Xcode (same Xcode project, different scheme) |

## Threat model (TL;DR)

The user's nsec is the most sensitive data we store. Trade-offs by platform:

| Platform | Default storage | With password set | Notes |
|---|---|---|---|
| Chrome / Firefox | `browser.storage.local` plaintext | AES-GCM-256, key from PBKDF2-SHA256 (600k) | User opts in via SetPassword. Plaintext default matches `nos2x`. |
| Safari macOS / iOS | Apple Keychain via native bridge | (Keychain already encrypts) | OS-managed encryption-at-rest, biometric-gated reads. |

Full threat model in [`SECURITY.md`](SECURITY.md): what the encryption
buys you, what it doesn't, the cache-mode trade-offs, and the
specific attacker classes the extension defends against.

## See also

- [`SECURITY.md`](SECURITY.md) — extension-specific threat model
- `docs/api-v1.md` (in the main repo) — full API surface
- `docs/architecture.md` — how Deepmarks fits together
- `design_handoff_deepmarks_extension/README.md` — design spec for these screens
