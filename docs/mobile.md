# Mobile Apps

The mobile apps are open-source Capacitor builds of the same frontend
experience. They share the Nostr bookmark model with the web app and
browser extensions.

Native source lives in:

- `frontend/ios/App/App.xcodeproj`
- `frontend/android`

The public mirror keeps both native shells so the website, extension,
iOS app, and Android app can be audited and rebuilt from source.

Release status: the native source is part of the public project. iOS is
published on the App Store, Android is in Google Play testing and
Zapstore preparation. Both shells should be built from the checked-in
frontend bundle after `npm run build` / `npm run build:apple` and
`npx cap sync`.

## Account Creation

iOS and Android can create or import Nostr identities. The recovery key
is still the user's long-term account root and must be backed up.

Passkey unlock is supported where the platform authenticator supports
the required WebAuthn behavior. Browser- or password-manager-specific
limitations can still prevent the WebAuthn PRF path from appearing.

Mobile import supports paste and QR scan. The QR scanner accepts a
plain `nsec1...`, a 64-character hex key, or a Deepmarks backup text
file rendered on another screen with an `nsec: ...` line. The web app
and browser extension generate `.txt` backups that include an ASCII QR
block specifically for this flow.

## Bookmarking

Mobile users can save, view, search, tag, import, and export bookmarks
through the same Nostr event shapes:

- public bookmarks: `kind:39701`
- private bookmarks: encrypted `kind:30003`

The app should stay interoperable with the website and browser
extensions because the data is Nostr-native.

## Native shell specifics

The Capacitor shell wraps the SvelteKit build. A few native-only
behaviors:

- **`contentInset: 'never'`** in `frontend/capacitor.config.ts`. iOS
  WKWebView previously toggled its scroll-view safe-area inset
  depending on whether the page was scrollable, which made
  `position: fixed; bottom: 0` resolve to two different places — the
  bottom tab bar appeared at different heights when navigating
  between scrollable (bookmarks) and non-scrollable (empty search)
  routes. With `never`, the WebView spans the full screen and the bar
  itself handles the home-indicator clearance via
  `bottom: 0; padding-bottom: env(safe-area-inset-bottom)`.
- **Bottom tab bar** lives in `frontend/src/lib/components/NativeTabBar.svelte`
  and surfaces the native primary paths: bookmarks, friends, search,
  save, and tags. The sixth tab is a vertical-ellipsis "more" control
  that opens explore and settings. The top section nav hides its
  `archives` tab on native shell; archive access on mobile is primarily
  through each bookmark row's archive/open controls rather than a
  dedicated bottom tab.
- **Native identity avatar is display-only.** iOS and Android do not
  expose the web profile/settings menu from the top-right avatar; mobile
  navigation goes through the bottom tabs, with settings under the
  bottom-tab "more" menu.
- **Foreground refresh hook**: `MobileAppLockGate.svelte` registers a
  Capacitor `appStateChange` listener that triggers
  `refreshOwnBookmarks()` whenever the app returns from background.
  Combined with the durable publish queue, this is what makes saves
  on one device appear on the others within seconds of opening the
  app.
- **Publish timeout** is 20 s for the `/publish` POST because iOS can
  abort foreground-transition fetches while the network stack is still
  reconnecting. Lives in `frontend/src/lib/nostr/publish.ts`.
- **Save flow durability**: the durable publish queue auto-retries
  any save whose initial `/publish` POST did not reach the server.
  See [durable-publish.md](durable-publish.md). This is how saves
  made offline or on flaky LTE eventually reach the relay pipeline.

## Native Share Sheets

iOS and Android both expose a native Save Link form from the platform
share sheet. The form lets the user edit URL, title, description, tags,
read-later, and visibility before saving.

Public saves use the privacy-preserving server-mediated model directly
from the share sheet when a local nsec is available: the native layer
signs a `kind:39701` event, builds NIP-98 auth, and POSTs to
`https://api.deepmarks.org/publish`. The server writes to
`relay.deepmarks.org` and fans out to the user's NIP-65 write relays.
The native share sheets stamp both `published_at` and, for newer builds,
`published_at_ms` so a batch of fast shares keeps the user's capture
order when it later appears on web, iOS, Android, feeds, and archives.

Private saves, missing local keys, or native publish failures fall back
to the host app with the edited payload queued for `/app/save`. Queued
public saves that were already posted by the native share sheet are
marked `published: "1"`, so the host app updates local state without
posting a duplicate event.

## Mobile Payment Constraints

The mobile app allows account creation, normal bookmarking, search, and
zaps. Payment-sensitive flows differ by store:

- iOS hides hosted checkout buttons, raw Lightning invoices, and paid
  purchase links. Lifetime and add-on purchases are completed on the
  website, then the iOS app unlocks the resulting entitlements after its
  server status check.
- Android uses the normal web bundle, so the free/lifetime picker,
  BTCPay-hosted lifetime checkout, and BTCPay-hosted add-on checkout can
  run inside the app where Play policy allows them.
- Archive controls are available only after the identity is already
  lifetime.

This keeps the iOS App Store surface simple while preserving the full
archive experience for lifetime users who upgraded elsewhere.

iOS onboarding skips the free/lifetime tier picker entirely. New users
land in bookmarks after account setup, and existing lifetime accounts
unlock lifetime features automatically after the server status check.

Android checkout still signs the `/account/lifetime` or add-on request
with NIP-98 and relies on the BTCPay settlement webhook to stamp the
pubkey.

## Mobile Signer

The mobile app can act as a signer for other Nostr apps where platform
restrictions allow it. This mirrors the extension's NIP-07 role and
mobile signer apps such as Amber: the user keeps the key in Deepmarks
and approves signing requests from other apps.

Implementation details are platform-specific and compatible with the
web/extension signer permission model:

- NIP-46 `nostrconnect://` pairing links for remote signing.
- Android NIP-55 `nostrsigner:` intents for native app-to-app signing.
- iOS custom URL schemes for signer pairing/deep-link entry points.
- Device secure storage through Android Keystore and iOS Keychain.
- Camera QR scanning for `nostrconnect://` pairings and nsec import.

Android now includes an opt-in native foreground NIP-46 service. When
enabled from the mobile signer screen, Android shows a persistent
notification and keeps relay subscriptions open for paired clients.
If the foreground service is off, Android falls back to the in-app
JavaScript listener while the WebView process is alive.

iOS signs while the app is open. Push-assisted or server-coordinated
iOS signing remains a future layer because iOS does not allow an
always-on arbitrary relay listener in the background.

Implementation details and release checks are tracked in
[android-foreground-signer.md](android-foreground-signer.md).

The web login screen can pair directly with the phone signer by showing
a Nostr Connect QR and `deepmarks://signer?connect=...` deep link. After
pairing, the browser stores the NIP-46 pairing payload; it does not
store the phone's nsec.

Native permission notes:

- iOS requires `NSCameraUsageDescription` in `Info.plist`.
- Android requires `android.permission.CAMERA`; the camera feature is
  declared optional so tablets or unusual devices are not excluded from
  install.

## Release Gates

Keep generated native build artifacts, signing state, keystores, and
provisioning files out of Git. Store releases should be built only after
the matching web bundle has been built and synced into the native
projects.

Before mobile store submission or resubmission:

- test Android install, login, save, signer key storage, NIP-46 pairing,
  QR import, share-sheet edit/publish fallback, and NIP-55 request
  approval on a real device
- test iOS install, recovery-key QR import, share extension visibility
  from Safari/Chrome, share-sheet edit/publish fallback, and NIP-46
  pairing from the web login QR
- generate and protect the Android release keystore
- paste the Android signing certificate SHA-256 into
  `frontend/static/.well-known/assetlinks.json`
- set the real Apple Developer Team ID in
  `frontend/static/.well-known/apple-app-site-association`
- confirm Xcode signing, capabilities, associated domains, and archive
  upload from `frontend/ios/App/App.xcodeproj`
- run `npx cap sync ios` and `npx cap sync android` after the final web
  build for the release
