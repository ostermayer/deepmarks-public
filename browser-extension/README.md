# Deepmarks browser extension

Save bookmarks to Nostr from any tab. Cross-browser MV3 extension —
ships to **Chrome / Edge / Brave / Arc**, **Firefox**, and
**Safari (macOS + iOS)** from the same `src/` tree.

## What's in this folder

```
browser-extension/
├── design_handoff_deepmarks_extension/   # ← read-only design spec (don't edit)
├── chrome/          # Chrome release zip + matching unpacked code
├── firefox/         # Firefox release zip + matching unpacked code
├── src/
│   ├── popup/         # 9 screens + tiny in-memory router
│   │   ├── App.tsx
│   │   ├── router.ts
│   │   ├── components/
│   │   │   ├── BackButton.tsx
│   │   │   └── TagInput.tsx
│   │   └── screens/
│   │       ├── Onboarding.tsx     # first-run welcome
│   │       ├── Login.tsx          # import/create identity + encrypt local nsec copy
│   │       ├── SetPassword.tsx    # migrate legacy plaintext accounts
│   │       ├── Unlock.tsx         # password prompt for encrypted accounts
│   │       ├── Recent.tsx         # default landing — your bookmark feed
│   │       ├── Add.tsx            # save current tab (private/public toggle)
│   │       ├── Saved.tsx          # post-save confirmation + archive flow
│   │       ├── SignRequest.tsx    # NIP-07 approval for any web page
│   │       └── Settings.tsx       # security, relays, tags, archive defaults
│   ├── background/    # service worker (NIP-07/WebLN bridge, ⌘D handler)
│   ├── content-scripts/   # NIP-07 + WebLN providers, page-metadata scrape
│   ├── lib/
│   │   ├── nsec-store.ts          # password-encrypted nsec by default
│   │   ├── nsec-crypto.ts         # PBKDF2-SHA256 (600k) + AES-GCM-256
│   │   ├── settings-store.ts      # relays, tags, NIP-07 grants
│   │   ├── nostr.ts               # publish kind:39701 + read feed
│   │   ├── private-bookmarks.ts   # NIP-51 kind:30003 + NIP-44 v2 self-encrypt
│   │   ├── nip98.ts               # build NIP-98 auth headers
│   │   ├── archive.ts             # lifetime status, upgrade checkout, archive enqueue + status/queue poll
│   │   ├── lifetime-archive-backfill.ts # background archive queue for existing lifetime saves
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
npm run package:stores
# -> chrome/deepmarks-chrome.zip and chrome/code/
# -> firefox/deepmarks-firefox.zip and firefox/code/

# Or one store package at a time:
npm run package:chrome
# -> chrome/deepmarks-chrome.zip and chrome/code/

npm run package:firefox
# -> firefox/deepmarks-firefox.zip and firefox/code/
# Safari ships through Xcode → App Store Connect, not zips
```

Chrome Web Store and Mozilla AMO upload is manual. The release workflow
builds and verifies these zips; the operator submits them through the
store dashboards.

Watch mode (HMR for the popup, manual reload for content scripts / SW):

```bash
npm run dev
```

## Architecture

### Storage

All state lives in `chrome.storage.local` via two facades:

- **`lib/nsec-store.ts`** — single getter/setter/clear for the user's
  private key. Versioned schema. Two record shapes:
  - `EncryptedAccount` — default for new imports/generated identities.
    The nsec is stored as AES-GCM-256 ciphertext, with the key derived
    from the user's extension password via PBKDF2-SHA256 (600 000
    iterations, 16-byte random salt). The derived key is cached in
    `chrome.storage.session` (cleared on browser close) or, when the
    user picks "remember 30 days", mirrored to `chrome.storage.local`
    with a TTL timestamp.
  - `PlainAccount` — legacy/dev shape for an unwrapped nsec. Existing
    plaintext records are routed to the password screen on popup boot.
    Settings can still remove password protection explicitly, but this
    is no longer the first-run default.

  See `SECURITY.md` for the full threat model.

- **`lib/settings-store.ts`** — relays, default tags, archive
  preferences, default visibility (private/public), saved NIP-07
  logins (forever-grants). Every mutating write goes through a
  single-flight chain so popup + background can't lost-update each
  other on the `savedLogins` array.

- **`lib/nwc-store.ts`** — one optional Nostr Wallet Connect record.
  New NWC connections require the account password to be unlocked and
  store the wallet spending secret as AES-GCM ciphertext under the same
  cached account key as the nsec, then publish the same connection as a
  NIP-44 self-encrypted `deepmarks-nwc` set for cross-device sync. Legacy
  plaintext NWC records migrate the next time the password is unlocked.

### What hits our API, what stays pure Nostr

The extension uses the same privacy-preserving publish model as the web
and mobile apps. Public bookmarks are signed locally as `kind:39701`,
private bookmark sets are signed/encrypted locally as `kind:30003`, and
the signed events are POSTed to Deepmarks' `/publish` endpoint by
default. The server writes to `relay.deepmarks.org` and fans out to the
user's NIP-65 write relays, so third-party relays see the Deepmarks
server IP rather than the user's browser IP. Advanced users can opt into
direct relay publishing from extension settings.

The extension still talks to relays directly for reading, signer
interoperability, and direct-publish mode, and it acts as a normal
NIP-07 signer for third-party Nostr sites.

Deepmarks-specific API calls:

| Endpoint | When |
|---|---|
| `POST /publish` | Default public/private bookmark publish path after local signing/encryption |
| `GET /account/lifetime/status?pubkey=…` | Check if user is a lifetime member and gate archive controls |
| `POST /account/lifetime` (NIP-98) | Mint a BTCPay invoice to upgrade to lifetime |
| `GET /account/settings` / `PUT /account/settings` (NIP-98) | Sync non-secret relays, tags, visibility, archive default, and Blossom backups |
| `POST /archive/lifetime` (NIP-98) | Enqueue an archive for lifetime members, optionally with user-owned backup Blossom servers |
| `POST /archive/browser-capture` (NIP-98) | Enqueue an encrypted private archive from the current tab's captured browser view |
| `GET /archive/status/:paymentHash` | Poll archive job state |
| `GET /account/archives` (NIP-98) | List the user's completed archives |
| `GET /account/archive-queue` (NIP-98) | Count the user's pending/running server archive jobs |
| `GET/POST /add-on/video-archive/*` (NIP-98) | Legacy-named media archive add-on status, checkout, and enqueue endpoints |

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

The extension defines `window.nostr` and, when no other wallet
extension got there first, `window.webln` at `document_start` on every
`https://*` page. It also exposes `window.deepmarks.nostr` as an
explicit first-party provider. deepmarks.org uses that provider for
auto-login, NIP-98 account requests, private-set coordination, and
archive backfill so an unlocked Deepmarks extension should not show a
generic "connect signer" prompt on Deepmarks' own site.

Two content scripts split the work:

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

### WebLN / NWC wallet bridge

Settings accepts a `nostr+walletconnect://` URI and stores it as the
extension's per-wallet NWC connection. The relay URL and wallet pubkey
remain visible metadata; the NWC app secret is encrypted with the same
password-derived account key that protects the user's nsec. The
connection is also published as a NIP-44 self-encrypted
`kind:30003` record with `d="deepmarks-nwc"` so the same wallet works
from the web app, mobile app, and extension after the user adds it once.
Removing password protection disconnects the local NWC copy instead of
writing the wallet secret back to plaintext.

The content script exposes that wallet to web apps via `window.webln`
unless Alby, Mutiny, or another WebLN provider has already injected one.

Supported WebLN methods:

- `enable()` — prompts once per origin unless a remembered origin grant
  exists and verifies that an NWC connection is configured.
- `getInfo()` — returns the connected wallet pubkey and the supported
  `sendPayment` method.
- `sendPayment(invoice)` — prompts every time, then sends NIP-47
  `pay_invoice` through the stored NWC connection and returns the
  wallet preimage.

Payment requests never use remembered origin grants. Even if a site has
a saved login for signing or wallet discovery, every Lightning invoice
still requires an explicit approval click in the popup before the NWC
secret is used. The approval screen decodes the BOLT-11 invoice and
shows amount, description, expiry, network, and an abbreviated invoice
before the user approves.

## Distribution

| Browser | Where to publish |
|---|---|
| Chrome / Edge | Chrome Web Store + Edge Add-ons (same zip works for both, separate listings) |
| Brave / Arc | Inherits from Chrome Web Store automatically |
| Firefox | addons.mozilla.org (signed `.xpi`) |
| Safari macOS | Mac App Store via Xcode (see `safari/`) |
| Safari iOS | App Store via Xcode (same Xcode project, different scheme) |

Run `npm run package:chrome` before a Chrome Web Store upload and use
`browser-extension/chrome/deepmarks-chrome.zip`. Run
`npm run package:firefox` before an addons.mozilla.org upload and use
`browser-extension/firefox/deepmarks-firefox.zip`. The sibling `code/`
folders are the unpacked builds that exactly match each zip.

## Threat model (TL;DR)

The user's nsec is the most sensitive data we store. Trade-offs by platform:

| Platform | Default storage | Unlock cache | Notes |
|---|---|---|---|
| Chrome / Firefox | `browser.storage.local` encrypted record | Derived AES key in `chrome.storage.session`, or 30-day local cache if selected | New imports/generated identities never write a plaintext account first. |
| Safari macOS / iOS | Same encrypted extension storage today; Keychain bridge is next | Same as Chrome/Firefox until JS-side Keychain wiring lands | Apple build strips lifetime-upgrade payment links; lifetime members still get archive controls. |

Full threat model in [`SECURITY.md`](SECURITY.md): what the encryption
buys you, what it doesn't, the cache-mode trade-offs, and the
specific attacker classes the extension defends against.

## See also

- [`SECURITY.md`](SECURITY.md) — extension-specific threat model
- `docs/api-v1.md` (in the main repo) — full API surface
- `docs/architecture.md` — how Deepmarks fits together
- `design_handoff_deepmarks_extension/README.md` — design spec for these screens
