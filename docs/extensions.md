# Browser Extensions

The browser extension is the first-class companion to the web app. It
saves bookmarks from the current tab and can act as a Nostr signer for
other websites.

## Supported Builds

The source lives in `browser-extension/src`.

Release packages are produced into:

- `browser-extension/chrome/deepmarks-chrome.zip`
- `browser-extension/chrome/code/`
- `browser-extension/firefox/deepmarks-firefox.zip`
- `browser-extension/firefox/code/`

Chrome and Firefox builds are intentionally separated because the store
packages and small manifest/runtime differences are not identical.
Chrome Web Store and Mozilla AMO submission is manual: the repository
builds and verifies the zips, and the operator uploads them through the
store dashboards.

## Bookmarking

The extension can save:

- public bookmarks as `kind:39701`
- private bookmarks inside encrypted `kind:30003` NIP-51 sets

Public saves are signed locally and POSTed to `/publish`, the same
server-mediated path the web app and mobile apps use. The server writes
the accepted event to `relay.deepmarks.org` and the relay-fanout worker
propagates it to the user's NIP-65 write relays (see
[`relay-policy.md`](relay-policy.md)). Private saves are encrypted to
self with NIP-44 v2 and published as a single per-item event
(`kind:30003`, `d=deepmarks-private-item:<sha256(url)>`) over the same
`/publish` path; private deletes publish an encrypted per-item
tombstone. The extension also reads and merges the chunked, versioned
set format the bulk importer writes, so large web imports render
intact — and because saves never rewrite the chunked set, an extension
save cannot collapse a large import to a partial set.

The default route is privacy-preserving server-mediated publish. Users
who explicitly want browser-to-relay behavior can switch the extension
to direct publish mode in extension settings; that mode publishes to the
write-enabled relays in the extension relay list.

Archive controls are lifetime-gated and default on for lifetime users
until the user turns that default off. There are no 500-sat archive
invoices in the current product.

When a lifetime user has existing saves, the extension can enqueue
missing archives from the unlocked browser context. It uses
`/account/archive-queue` and local queue markers to avoid repeatedly
submitting the same URL while Box B is still draining older work.

## Signer Mode

The extension exposes `window.nostr` on normal HTTPS pages when another
NIP-07 signer has not already claimed it. Sign requests go through the
extension popup, with remembered grants for normal low-risk actions and
always-prompt protection for sensitive event kinds such as profile
rewrites, contact lists, deletions, and sealed DMs.

Deepmarks' own production web origin can silently self-encrypt private
bookmark chunks and sign Deepmarks bookmark/private-set events through
the extension. This first-party path is deliberately narrow so large
imports do not require hundreds of "approve encrypted message" clicks,
while unrelated sites still prompt for encryption/decryption.

It also exposes `window.deepmarks.nostr` with a first-party marker.
deepmarks.org uses that explicit provider for auto-login and private
Deepmarks API coordination without changing the manual NIP-07 path for
Alby, nos2x, Flamingo, and other signers.
When that provider is present and unlocked, Deepmarks should attach it
directly instead of showing a generic "connect signer" call to action on
first-party write/archive flows.

This is the web-extension equivalent of using a dedicated signer app
such as Amber.

## Settings Sync

When the extension is unlocked, non-secret preferences sync through
`/account/settings` with NIP-98 auth. Synced fields include relays,
default tags, default visibility, archive-by-default, backup Blossom
servers, theme, plus whether archive-by-default was manually
overridden. Saved website grants and encrypted nsec records stay
device-local. NWC credentials are also device-local and are not sent
through `/account/settings` or relays.

## NWC / WebLN

Users can add a Nostr Wallet Connect URI. The NWC secret is encrypted
with the same password-derived key used for the user's nsec locally and
stays on that browser profile. Users who want one-tap zaps on mobile,
the website, and the extension connect the wallet separately on each
client. The extension can expose a WebLN bridge so supported sites can
request Lightning payments through the user's connected wallet.

Payment limits are enforced by the user's wallet. Deepmarks is not a
wallet and does not custody funds.

## Security Posture

New extension accounts store the nsec encrypted by default. Legacy
plaintext records are routed through migration screens. If password
protection is removed, NWC is disconnected rather than writing the NWC
secret back to plaintext.

If a user forgets the extension password, the lock screen can restore
the account from a backed-up `nsec` and set a new device password. This
replaces the locked local key copy and disconnects NWC, because the old
wallet secret was encrypted with the forgotten password-derived key.

Generated identities and Settings → Reveal nsec can export a plain text
backup with an `nsec:` line and ASCII QR block. The revealed settings UI
also shows a normal QR image so the Deepmarks mobile app can import the
same key into platform secure storage.

Detailed extension internals live in
[`browser-extension/README.md`](../browser-extension/README.md) and the
extension threat model lives in
[`browser-extension/SECURITY.md`](../browser-extension/SECURITY.md).
