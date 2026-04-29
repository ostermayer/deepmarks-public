# Handoff: Deepmarks Browser Extension

## Overview
Deepmarks is a Nostr-native bookmarking service (the web companion to deepmarks.org, similar in spirit to Pinboard / classic Delicious). This bundle contains the design for the **browser extension** that lets a user:

1. Sign in by pasting their `nsec` private key (stored only on the user's device).
2. Click a toolbar icon on any page to save a bookmark — autofilled title/description, chip-style tags with autocomplete, and an "archive forever" toggle that triggers a snapshot via the Deepmarks headless-Chromium archive node.
3. Use the same key as a NIP-07 signer for any Nostr-enabled site (e.g. Stacker News). Sites can be remembered for one session, an hour, or forever (added to a "Saved logins" list in settings).

## About the Design Files
The files in this bundle are **design references created in HTML** — interactive prototypes showing the intended look and behavior. They are **not production code to copy directly**. Your job is to recreate them in a real WebExtension codebase (Manifest V3 — Chrome / Firefox / Brave / Arc), using the existing patterns of that codebase. If no codebase exists yet, scaffold one with the framework most appropriate for an MV3 extension (React + Vite is a sensible default; Preact if bundle size matters).

The HTML mocks ship as a single page with two views (`Prototype` and `All screens`). Run them by opening `Deepmarks Extension.html`. Every popup surface is rendered at the real extension popup size (400×560), which is the production target.

## Fidelity
**High-fidelity (hifi).** Pixel-perfect mockups with final colors, typography, spacing, copy, and interactions. Recreate the UI as closely as possible using the codebase's libraries. Do not improvise replacements for the visual system — it's deliberate (Pinboard-inspired utilitarian minimalism).

## Target environment
- **Manifest V3** browser extension (Chrome + Firefox MV3 polyfill)
- Popup window dimensions: **400 × 560 px** (settings opens in a wider 720-wide page in its own tab)
- Background service worker holds the nsec in memory; persistent storage is encrypted at rest in `chrome.storage.local` (passphrase-derived key, or OS keychain via `chrome.storage.session` for short-lived caching)
- Nostr libraries: `nostr-tools` (preferred) or `@nostrify/nostrify`. NIP-07 `window.nostr` provider injected via content script
- Default Nostr event kind for bookmarks: **kind 39701** (web bookmark, parameterized replaceable). Auth events for sign-in: **kind 22242** (NIP-42)

## Screens / Views
The extension has 7 surfaces. Each is a self-contained component in the mocks (see "Files" below).

### 1. Onboarding (first run)
- **Purpose**: Welcome a new user and explain what the extension does before they paste their key.
- **Layout**: Header → body → footer.
  - Body: `<h1>` "Bookmarks you actually own." (22px / 1.15 / weight 500). Subtitle paragraph below in `inkSoft`.
  - Three numbered bullets ("01 / 02 / 03") in mono with description text in `inkSoft`. Numbers are accent-colored.
  - "New to nostr?" panel near the bottom — sand-colored card directing to `nostr.how/get-started`.
- **Footer**: full-width primary button "Sign in with nsec".

### 2. Login (paste nsec)
- **Purpose**: Capture the user's `nsec1…` private key.
- **Layout**:
  - "Paste your nsec" heading with "Stays on this device. Never sent anywhere." subtitle.
  - `private key` label (uppercase 10px) → password-type input with mono font, placeholder `nsec1…`.
  - Inline warning row in mono: `! your nsec is your password. don't paste it into apps you don't trust.`
  - Divider, then "Don't have one? Generate a new key →" link.
- **Footer**: "encrypted at rest" hint left, primary "Unlock" button right (disabled until value starts with `nsec1` and length ≥ 60).

### 3. Recent (default popup view)
- **Purpose**: Quick view of recently saved bookmarks, jump-off point to add the current page.
- **Layout**:
  - Header with brand + "settings" ghost button right.
  - Filter input (`filter by title or #tag`).
  - Tab bar: `mine / tags / archived` underline tabs, count chip right-aligned (`7 of 248` in mono).
  - List rows: 14px favicon + title (12.5px / weight 500, single-line ellipsis) + meta line (`host · 2m · archived` in mono 10.5px) + chip row of tags (18px tall, mono 10.5px).
  - Footer: primary button "+ Bookmark this page" with `⌘D` kbd hint.

### 4. Add bookmark
- **Purpose**: Create a bookmark for the active tab.
- **Layout**:
  - URL preview chip at top (favicon + URL in mono + "AUTOFILLED" badge in good-green if the form was prefilled by content-script scrape).
  - `title` input (defaults to scraped `<title>` / `og:title`).
  - `description` textarea (defaults to `<meta name="description">` / `og:description`).
  - `tags` chip input — see Tag Input spec below.
  - Footer is two-row: row 1 is the **archive toggle** (28×16 pill switch + "Archive forever" / "Snapshot stored on deepmarks archive node" subtitle); row 2 is `Cancel` / `Save bookmark ⏎`.

### 5. Saved (confirmation)
- **Purpose**: Confirm publish, show archive progress.
- **Layout**:
  - Green check circle + "Bookmarked" + `kind:39701` mono label right.
  - Saved-card: white card with hairline border, favicon + host, title, tag chips.
  - Archive progress meter: 2px hairline track, accent fill, label "capturing… NN%" → "archived ✓".
  - Mono receipt list: `· published to 4 relays`, `· event id e7f3…b21a`, `· snapshot stored at archive.deepmarks.org/3kf2…`.
  - Footer: `+ Add another` left, "View on deepmarks ↗" ghost button right.

### 6. Sign-in request (NIP-07)
- **Purpose**: A site (e.g. Stacker News) calls `window.nostr.signEvent()` and we need the user to approve.
- **Layout**:
  - "REQUESTED BY" label → site card with favicon, hostname, full URL, and a green "VERIFIED SSL" pill.
  - "ACTION" label → sand panel: `Sign a kind:22242 auth event with your nostr key`.
  - "EVENT PREVIEW" label → preformatted JSON of the event (mono 10.5px, white card).
  - "REMEMBER DECISION" label → radio group:
    - `Just this time`
    - `Until I close the browser`
    - `For 1 hour`
    - `Forever — add to saved logins` (★ marker right-aligned)
  - Footer: `Reject` / `Approve & sign` (both 50% width).

### 7. Settings (opens in own tab, 720×560)
Sidebar (160 wide) + main pane. Sections:
- **Relays** — table of relay URL + read toggle + write toggle + delete-x. Bottom row is `wss://…` input + "+ Add relay" button.
- **Archiving** — three rows: "Archive new bookmarks by default" toggle, "Only archive pages over a paywall I have access to" toggle, "Snapshot quality" select (`fast / standard / archival`). Storage card at bottom: `248 snapshots · 412 MB · manage →`.
- **Default tags** — chip input pre-populated with `toread`.
- **Saved logins** — list of sites approved "Forever" with favicon, hostname, "last used Nd ago", and "revoke" ghost button per row.
- **Account** — readonly npub input, "Export bookmarks as JSON" button, "Sign out" danger button.

## Interactions & Behavior

### Tag chip input
- Typing + `Enter` / `,` / space commits a tag.
- Tags are normalized: lowercased, leading `#` stripped, internal whitespace → `-`.
- Backspace on empty input removes the last chip.
- When input is focused (and not empty in the chip list), suggestion chips appear below labeled `RECENT` — clicking adds the tag. Suggestions are filtered by the current input value.
- Dedup against current chips.

### Toolbar icon (extension action)
- Default click → opens **Recent** popup.
- Optional keyboard shortcut **⌘D** (Cmd-D / Ctrl-D) → opens **Add** popup directly. Wire via `chrome.commands` in manifest.
- Badge shows count of bookmarks pending publish (red, white text).

### Autofill on Add
- Content script reads on demand (not eagerly): `document.title`, `meta[property="og:title"]`, `meta[name="description"]`, `meta[property="og:description"]`. Sends back to popup via `chrome.runtime.sendMessage`.
- "AUTOFILLED" badge persists until the user edits the title field; first edit clears it.

### Saving a bookmark
1. Build a `kind:39701` event (parameterized replaceable, `d` tag = bookmark URL):
   ```
   {
     kind: 39701,
     pubkey: <hex from nsec>,
     created_at: now,
     tags: [
       ["d", url],
       ["title", title],
       ["summary", description],
       ["t", tag1], ["t", tag2], …
     ],
     content: ""
   }
   ```
2. Sign with `nostr-tools.finalizeEvent(unsigned, sk)`.
3. Publish to all write-enabled relays in parallel via `SimplePool.publish`.
4. If `archive` toggle is on, POST to `https://archive.deepmarks.org/v1/snapshot` with `{ url, event_id }` and a HTTP signature header derived from the user's pubkey. The Saved screen polls `GET /v1/snapshot/:event_id` for progress.
5. The Saved screen renders the publish receipt as a list of relay accept/reject results.

### NIP-07 signer
- Inject a content script at `document_start` that defines `window.nostr` with `getPublicKey`, `signEvent`, `getRelays`, `nip04.encrypt/decrypt`.
- Each call posts a `chrome.runtime` message to the service worker; if the origin is in the `forever` allowlist, return signed result without UI; otherwise open the **Sign-in request** popup.
- Approve flow: pubkey + signed event back to content script, which resolves `window.nostr.signEvent`'s promise.
- Reject flow: throw `{ error: "rejected" }` to the page so the calling site can handle gracefully.
- "Forever" choice persists `{ origin, kinds: [...] }` in `chrome.storage.local.savedLogins`. The Settings → Saved logins page reads from this list.

### Animations / transitions
- Toggles: `background .15s` color, `transform .15s` for the knob.
- Buttons: `border-color .12s, background .12s` on hover.
- Tabs (filter, settings sidebar): instant.
- Archive meter: width transitions over `.25s`.
- No page-level transitions between popup screens — they're routes within a tiny in-memory router.

### Loading & error states (implement, not in mocks but required)
- Login: spinner replaces "Unlock" while deriving keys.
- Saved: if all relays reject, replace meter with red "Failed to publish — retry" row.
- Archive: if snapshot service unreachable, show "Archive queued — will retry" with a clock icon.
- NIP-07: if no nsec is loaded yet, the sign-in request popup shows the Login screen first, then proceeds.

### Form validation
- nsec: must start with `nsec1` and be ≥ 60 chars (proper validation with `nip19.decode` before unlocking).
- URL field on bookmark add: implicit, comes from `chrome.tabs.query({active, currentWindow})`.
- Title required (cannot save empty), description optional.

## State management
A small, in-memory store in the popup is sufficient — Zustand or `useReducer` works. No Redux. Persistent state lives in `chrome.storage`:

- `chrome.storage.local`:
  - `nsec_encrypted` — AES-GCM ciphertext, key derived from a passphrase (or `chrome.storage.session` for unlock-on-first-use)
  - `pubkey` (cached, derivable but kept for fast NIP-07 reads)
  - `relays: [{ url, read, write }]`
  - `default_tags: [string]`
  - `archive_default: boolean`
  - `archive_only_paywalled: boolean`
  - `archive_quality: 'fast' | 'standard' | 'archival'`
  - `saved_logins: [{ origin, granted_at }]`
- `chrome.storage.session` (cleared when browser closes):
  - `nsec_unlocked` — decrypted key bytes (only while session is active)
  - `session_logins: [{ origin, expires_at }]`

## Design tokens
All values are exact. Source of truth: `popup-base.jsx`.

### Colors
| Name | Value | Use |
|---|---|---|
| `paper` | `#fbfaf7` | Popup background, footer |
| `paperAlt` | `#f4f1e9` | Card panels, hover states |
| `ink` | `#1a1a1a` | Primary text, primary button |
| `inkSoft` | `#3d3a35` | Body copy |
| `muted` | `#827d72` | Labels, meta, mono receipts |
| `hairline` | `#e6e2d8` | Borders, dividers |
| `hairlineSoft` | `#efece4` | List row dividers |
| `accent` | `oklch(0.55 0.15 25)` ≈ `#c96442` | Brand wordmark, links, archive meter, badges |
| `tagBg` | `#efeadd` | Tag chip background |
| `good` | `oklch(0.55 0.13 145)` | Success check, "AUTOFILLED" badge |
| `warn` | `oklch(0.6 0.13 70)` | Inline warnings |

The pennant logo is its own crayon-orange `#ff6b5a` — keep that exact shade for the icon (the rest of the system uses the slightly more muted `oklch` accent).

### Typography
- **Sans**: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` — UI body, headings.
- **Mono**: `ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace` with `font-feature-settings: "ss01","tnum"` — URLs, npubs, event ids, timestamps, tag chips, kbd hints, uppercase labels.
- Sizes used: 22 / 15 / 14 / 13 / 12.5 / 12 / 11.5 / 11 / 10.5 / 10. Line heights 1.15 (h1), 1.35 (titles), 1.45 (body), 1.55 (paragraphs), 1.7 (long-form fake page).
- Uppercase labels: 10px, letter-spacing `0.08em`, weight 500, color `muted`.

### Spacing
8px base. Padding scale: 4 / 6 / 8 / 10 / 12 / 14 / 18 / 22.

### Border radius
- Cards / inputs / buttons: `3px`
- Pill toggle: `9px` track, `50%` knob
- Brand badge: `2px`
- Tag chips: `2px`
- Popup outer container: `6px`

### Shadows
- Popup container only: `0 24px 60px -12px rgba(20,15,5,0.18), 0 8px 16px -8px rgba(20,15,5,0.12)`
- Settings modal in prototype: `0 24px 60px -12px rgba(20,15,5,0.4)`
- All inner elements: **no shadows** — hairline borders only.

## Assets
- **`pennant.svg`** — the Deepmarks logo. 32×32 pixel-art pennant in `#ff6b5a`. Used at: 14px (popup header brand), 16px (toolbar icon), 14px (page header). It's drawn as `<rect>` primitives so it scales crisply at any size with `shape-rendering: crispEdges`.
- **Favicons** in mocks are placeholders generated deterministically from the hostname (HSL hue from char-code sum, first letter centered). In production, fetch real favicons via `chrome://favicon/` (MV2) or `_favicon` API (MV3 Chrome 104+); for Firefox use the page's `link[rel*=icon]`.

## Files in this bundle
| File | Purpose |
|---|---|
| `Deepmarks Extension.html` | Main entry — open this in a browser to view the prototype + design canvas |
| `popup-base.jsx` | Tokens, shared CSS, `PopHeader`, `Pennant`, `Favicon`, `TagInput` |
| `popup-screens-1.jsx` | `ScreenOnboarding`, `ScreenLogin`, `ScreenSaved` |
| `popup-screens-2.jsx` | `ScreenAdd`, `ScreenRecent` (with seed `RECENT_BOOKMARKS` data) |
| `popup-screens-3.jsx` | `ScreenSignRequest`, `ScreenSettings` (+ seed `SAVED_LOGINS`, `RELAYS` data) |
| `app.jsx` | Wires the prototype: fake browser chrome, popup mounting, screen routing, accent tweak, design canvas |
| `design-canvas.jsx` | Pan/zoom canvas component (presentation chrome only — drop in production) |
| `tweaks-panel.jsx` | Tweaks panel component (presentation chrome only — drop in production) |
| `pennant.svg` | The logo. Ship this as-is — it's the toolbar icon at 16/32/48/128. |

## Suggested implementation order
1. Stand up an MV3 extension scaffold (Vite + `@crxjs/vite-plugin` is the smoothest).
2. Build the storage + crypto layer (encrypt/decrypt nsec; derive pubkey).
3. Implement `PopHeader`, `Pennant`, `TagInput`, and the design tokens as a small component library.
4. Build screens in dependency order: Login → Recent → Add → Saved → Onboarding → Sign-in request → Settings.
5. Wire `nostr-tools` for kind 39701 publish + kind 22242 sign.
6. Build the content-script NIP-07 provider + service-worker bridge.
7. Wire the archive node API.
8. Polish error/loading states.
