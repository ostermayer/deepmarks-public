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

## Relays And Blossom Servers

Settings displays the user's NIP-65 relays when available and uses
server-synced Deepmarks settings for the app's defaults. Synced
preferences include:

- relay URLs and read/write flags
- default bookmark visibility
- default tags
- archive-by-default for lifetime users
- whether archive-by-default was manually overridden
- backup Blossom servers

These settings are stored behind NIP-98-authenticated
`/account/settings` requests so the website and first-party browser
extensions can converge on one preference set. Secrets are deliberately
excluded: NWC credentials, saved signer grants, passkey state, and
recovery keys remain device-local or in their dedicated encrypted
storage.

Built-in relay defaults are intentionally conservative: the Deepmarks
relay is always available for app-owned data, and the public fallback
set currently seeds `wss://nos.lol` and `wss://relay.primal.net`.
Synced user settings can add or remove relays from there.

Lifetime users default to archiving every save unless they manually turn
that default off. They can also add backup Blossom servers. New archive
jobs mirror to Deepmarks defaults plus the user's configured backup
servers.

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
