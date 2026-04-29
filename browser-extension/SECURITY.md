# Browser extension — security & threat model

What this document covers: the trust boundaries inside the Deepmarks
browser extension, what the optional password protection actually
buys you, the NIP-07 signer's gating logic, and the specific attacker
classes the extension defends against (and the ones it doesn't).

For the higher-level "what does Deepmarks do" question, see
`README.md` in this folder.

## 1. Where the nsec lives

| Storage mode | Where | When chosen | Encryption |
|---|---|---|---|
| **Plaintext** | `chrome.storage.local` | Default on Chrome/Firefox sign-in | None |
| **Encrypted** | `chrome.storage.local` (`encrypted: true` record) | User sets a password (Login → SetPassword, OR Settings → Security → Set password) | AES-GCM-256, key from PBKDF2-SHA256 (600 000 iterations, 16-byte random salt, 12-byte random IV per encryption) |
| **Safari Keychain** | OS Keychain via `KeychainBridge.swift` native messaging host | Default on Safari macOS/iOS | OS-managed; biometric-gated on iOS |

The plaintext default matches `nos2x` and other Nostr extensions. The
optional password is layered on top — it changes the disk-rest
posture but doesn't change anything the extension does at sign time.

### The two cache modes (encrypted accounts only)

Once the user enters their password, the derived AES key is cached
so they don't have to re-enter it every time the popup opens:

- **`session`** (default, "Prompt when browser reopens") — key
  cached in `chrome.storage.session` only. Cleared automatically
  when the browser shuts down. Most secure.
- **`days30`** (opt-in, "Remember for 30 days") — key also mirrored
  to `chrome.storage.local` with a `derivedKeyExpiresAt` timestamp.
  On every read we purge expired entries first, so a key past its
  TTL is gone before any code can see it.

When the user picks `Reveal nsec` from Settings, the password prompt
uses `revealNsecBech32WithPassword`, which decrypts **without
caching the derived key**. Otherwise the cache-mode picker on the
reveal prompt would silently extend the unlock window for unrelated
future operations (NIP-07 signing, archive purchases) just because
the user wanted to copy their nsec once.

The revealed nsec is also auto-hidden from the Settings UI after 30
seconds — long enough to copy/download, short enough that walking
away from an open popup doesn't leave the cleartext sitting in React
state.

## 2. What the password buys you (and doesn't)

### Buys you

- **Disk-grab attacker.** Browser profile copied off disk (a stolen
  laptop, an unattended sync target, a compromised backup) — without
  the password, the nsec is unrecoverable from the ciphertext alone.
- **Malware that reads `localStorage` but doesn't dump session
  memory** — same outcome.
- **Plaintext at rest** when the user wants it that way.

### Doesn't buy you

- **An attacker who runs malicious code inside the extension origin.**
  That code has the same `chrome.storage.session.get` access we do
  — if the key is cached, they can decrypt. If it isn't cached, they
  can prompt the user for the password (extension origin = trusted
  UI surface).
- **Shoulder-surfing or keylogging.** The password is typed; if it
  can be observed at typing time, encryption is moot.
- **Weak passwords.** PBKDF2 600k buys ~10² seconds of brute-force
  per attempt on commodity hardware — meaningful against
  `password123`-class passwords offline, not against
  `correct-horse-battery-staple`-class. Encryption doesn't replace
  password hygiene.

PBKDF2 was chosen over Argon2 because it's available in
`crypto.subtle` natively. 600 000 iterations is the OWASP 2023 floor
for SHA-256.

## 3. The NIP-07 signer

Deepmarks defines `window.nostr` at `document_start` on every
`https://*` page so it can act as a NIP-07 provider for third-party
Nostr clients (Damus web, snort.social, etc.). The provider runs as
a **MAIN-world** content script (Chrome 111+ / Firefox 128+) — no
inline-script injection, so strict-CSP pages (Gmail, Google Chat,
GitHub, X) work cleanly. A second **ISOLATED-world** content script
acts as the bridge to `chrome.runtime`, since the page world doesn't
have extension API access.

Every sensitive call hops:

```
page → window.nostr.X → window.postMessage (page → bridge)
     → chrome.runtime.sendMessage → background service worker
     → user prompt (or cached grant)
     → reply back along the same chain
```

### Origin-grant tiers

The user picks one when approving a request:

- **`just-once`** — one-shot; never cached.
- **`until-close`** — cached in service-worker memory until the SW
  is recycled (browser close, or Chrome's idle eviction).
- **`one-hour`** — same, with a wallclock expiry.
- **`forever`** — persisted to `settings.savedLogins` indefinitely.
  Visible + revocable from Settings.

### Always-prompt kinds

Even on a cached grant, these kinds force a fresh prompt:

| Kind | Why |
|---|---|
| `0` | Profile rewrite — overwrites your `name`, `picture`, `lud16` |
| `3` | Contact list rewrite |
| `5` | Deletion request — irreversible |
| `13` | Sealed DM (NIP-17) |
| `1059` | Gift wrap (NIP-59) |
| `10002` | Relay list rewrite (NIP-65) — moves your follows |

A user who approved a low-stakes kind once should not transitively
have blessed rewriting their profile or deleting all their events.
Matches what `nos2x` scopes per-kind in its prompt UI.

### Bridge hygiene

- **`window.postMessage` targets pinned origin**, not `'*'`. If the
  page navigates between request and reply, the message can't leak
  into a foreign document. nip04/nip44 decrypted plaintext is
  particularly sensitive here.
- **Page-side promise hard timeout: 60 s.** Without this, an MV3
  service-worker restart mid-call would leave the page's pending
  Map entry pinning its resolver + params closure for the
  document's lifetime.
- **Service-worker `pendingRequests` bounded.** Max 50 entries with
  FIFO eviction; entries past 5 min are evicted with an error reply.
  A hostile page can't OOM the worker by spamming `signEvent` calls.
- **Event template shape-validated** before `finalizeEvent`: kind is
  integer 0–65535, tags is `string[][]`, content is string. Stops
  malformed input from producing corrupt signed bytes on relays.

## 4. NIP-98 + lifetime checkout flow

The extension talks to `api.deepmarks.org` for four things only —
all of them tied to **archive** (rendered snapshots of bookmarked
pages, stored on Blossom) and the **lifetime upgrade** that unlocks
free archives.

NIP-98 auth headers are built in `lib/nip98.ts`:

```
Nostr <base64(JSON-stringified kind:27235 event)>
```

The event tags include `u` (request URL), `method`, and — on
body-bearing requests — `payload` (sha256 of the request body in
hex). The server enforces all three plus a 65 s replay-dedup window.

### Lifetime gating on archive-default

The "Archive new bookmarks by default" toggle in Settings is
gated on lifetime status. Free users who turn it on see an inline
BTCPay checkout panel (minted via `POST /account/lifetime`); the
extension polls `getLifetimeStatus` every 6 s while the panel is
open and flips to the toggle-on state once the upgrade settles.

## 5. URL safety

`assertSafeBookmarkUrl` is called inside `buildBookmarkTemplate`
before signing — no `javascript:`, `data:`, `file:`, or other
non-`http(s)` URLs ever reach relays. Both the public publish path
(`publishBookmark`) and the private path (`publishPrivateBookmark`,
which routes through `bookmarkInputToInnerTags` →
`buildBookmarkTemplate`) inherit this guard.

The web app's reader (`parseBookmarkEvent`) also filters non-`http(s)`
URLs on display, but enforcing at write time means a buggy import
or malicious tab URL gets a clear error instead of a silent
"published-but-invisible" outcome.

## 6. Settings storage atomicity

Every mutating write to `chrome.storage.local` for settings goes
through a single-flight chain (`withWriteLock`). Without this, the
background service worker (touching `savedLogins.lastUsedAt` on
every approved NIP-07 call) and the popup (flipping a toggle) can
race on the same record and lost-update each other.

## 7. What we DON'T defend against

- **A compromised Nostr relay.** The relay can withhold events,
  serve stale ones, or refuse to publish. Defense: use multiple
  relays (default 4) and trust the consensus.
- **A user who screenshots their nsec.** Once cleartext, ours.
- **Browser zero-days.** If the extension origin sandbox is broken
  by a Chrome bug, all bets are off — same as for every other
  browser-stored credential.
- **A user who installs a malicious second extension.** Other
  extensions cannot read `chrome.storage.local` from a foreign
  extension's namespace, but a malicious extension with `<all_urls>`
  host permissions can intercept `window.nostr` calls on every page
  before our injector runs. That's a browser-level trust decision
  the user makes when they install the malicious extension.

## See also

- `README.md` — extension overview + build/load instructions
- `safari/README.md` — Safari macOS/iOS Xcode wrap details
- `docs/api-v1.md` (main repo) — the API endpoints the extension calls
