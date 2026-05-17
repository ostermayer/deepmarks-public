# Settings

`/app/settings` is the account and recovery control surface. It does
not show the global header search bar because settings actions are not
bookmark-search workflows.

## Account And Recovery

The account section shows:

- public identity (`npub`)
- signer status
- recovery-key availability
- passkey status

When the active signer exposes the raw recovery key, the section can
reveal the `nsec` for 60 seconds, render a QR code for phone import,
and download a plain `.txt` backup. The backup contains both the
`nsec:` line and a monospace ASCII QR block. Extension and remote-signer
sessions intentionally do not expose the raw key here; users should
export from the signer that actually holds the key.

Passkey copy should describe the user outcome directly: add a passkey
to protect the account and sign in quickly on this device. WebAuthn PRF
support varies by browser and password manager.

## Profile

Settings can update:

- profile picture
- Lightning address
- Deepmarks handle

General Nostr profile fields remain better suited to full social Nostr
clients.

## Wallet

The NWC section stores one optional Nostr Wallet Connect connection for
zaps. When a wallet is connected on the website, bookmark zap dialogs
can pay directly. Without a wallet, zap dialogs show a normal Lightning
invoice and QR code path.

The browser extension also supports NWC and can expose WebLN to other
sites.

## New bookmark defaults

The settings page exposes three toggles for how new saves should
default:

- **Private vs public** — initial visibility for the save form. Stored
  as `defaultVisibility` in synced settings.
- **Mark new bookmarks as read later by default** — flips the
  `toread` tag in/out of `defaultTags`. Every save form (web, iOS
  share extension, browser extension) reads this and pre-toggles
  accordingly. Default: on.
- **Archive every bookmark by default** — lifetime-only. Stamps
  `archive-tier: forever` on saves so the worker picks them up
  automatically. Stored as `archiveAllByDefault`.

## Advanced (collapsed)

The relay list, Blossom backup servers, NWC, mobile signer, browser
extension links, re-sync buttons, and API keys all live behind a
single `<details class="advanced">` panel. Most users never need to
expand it. The defaults Just Work.

Inside the advanced panel:

- **Storage** — one editable relay list (read/write toggles per relay
  + remove). Renamed from "relays" so the wording is
  Nostr-jargon-free. Changes autosave and push to the server. Every
  change also debounce-broadcasts a fresh `kind:10002` (NIP-65 relay
  list) so other Nostr clients see the same set you've picked here.
- **Extra archive copies** — lifetime-only. Add personal Blossom
  servers that new archives mirror to in addition to the Deepmarks
  defaults.
- **Re-sync** — runs `republishAllOwnBookmarks` for public or private
  bookmarks. Used as a recovery path when a previous import or save
  flow failed to land some chunks on the relay. Walks the local
  ownBookmarks cache, encrypts + enqueues every chunk into the
  durable publish queue, and returns immediately. The queue drains
  in the background.
- **Mobile signer** — link to `/app/mobile-signer` for users who want
  to use the iOS / Android app as a NIP-46 remote signer for other
  Nostr apps.
- **Browser extensions** — install links for Chrome / Firefox.
- **API keys** — lifetime-only API key issuance.

## Following

A dedicated "following" section above the advanced panel shows:

- the current count of followed curators
- a "refresh from Nostr" button (re-reads the kind:3 contact list)
- a link to `/app/follows` (their bookmarks)

Deepmarks reuses the user's standard Nostr kind:3 contact list rather
than maintaining a parallel "Deepmarks follows" list. Following
someone on Damus / Primal / Amethyst counts here, and following
someone here writes back so it counts on the other clients too.

## Server-synced settings

Synced preferences:

- relay URLs and read/write flags
- default tags (controls the read-later default)
- default bookmark visibility
- archive-by-default for lifetime users
- archive-default-manual-override
- backup Blossom servers

These round-trip through NIP-98-authenticated `/account/settings`
requests so the website, iOS app, and first-party browser extension
converge on one preference set. Last-write-wins via
`updatedAt`. Secrets are deliberately excluded: NWC credentials,
saved signer grants (extension-only), passkey state, and recovery
keys remain device-local.

Built-in relay defaults seed `relay.deepmarks.org` (always retained),
`nos.lol`, and `relay.primal.net`. Synced user settings can add or
remove relays from there.

Lifetime users default to archiving every save unless they manually
turn it off. New archive jobs mirror to Deepmarks defaults plus any
configured backup servers.

## Lifetime And API Keys

Lifetime members unlock:

- archiving
- API key creation
- short handles
- all-archive zip downloads

API keys are issued only to lifetime members and are shown only once on
creation. Existing keys list metadata only.

## Destructive Actions

Account deletion and private-key reveal flows are intentionally explicit
and signer-gated. Public Nostr events can only be requested for deletion
by publishing deletion events; relays may vary in how completely they
honor those requests.
