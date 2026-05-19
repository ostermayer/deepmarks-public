# Mobile Apps

The mobile apps are open-source Capacitor builds of the same frontend
experience. They share the Nostr bookmark model with the web app and
browser extensions.

Native source lives in:

- `frontend/ios/App/App.xcodeproj`
- `frontend/android`

The public mirror keeps both native shells so the website, extension,
iOS app, and Android app can be audited and rebuilt from source.

Release status for 0.6.0: mobile source is included and documented, but
mobile app binaries are not part of the public release. Treat the native
projects as auditable/contributor source, not store-ready artifacts.

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
  and surfaces five primary tabs: bookmarks, search, save, archives,
  settings. The top "section nav" hides its `archives` tab on native
  shell to avoid doubling up with the bottom bar.
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

## App Store Payment Constraints

The mobile app allows account creation, normal bookmarking, search, and
zaps. Bitcoin payment-sensitive flows are restricted:

- lifetime upgrade is completed on the website
- archive controls are available only after the identity is already
  lifetime
- the app should not expose legacy 500-sat archive purchases

This keeps the app store surface simpler while preserving the full
archive experience for lifetime users who upgraded on the web.

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

The current NIP-46 signer service runs while the app process is alive.
Background/push-assisted signing is a separate release layer and should
not be assumed for the first store submission.

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

Do not attach iOS or Android binaries to the 0.6.0 public GitHub
release. Keep the source in the repository, document how it works, and
cut mobile app releases only after the store-submission gates below are
complete.

Before mobile store submission:

- test Android install, login, save, signer key storage, NIP-46 pairing,
  QR import, share-sheet save, and NIP-55 request approval on a real
  device
- test iOS install, recovery-key QR import, share extension visibility
  from Safari/Chrome, and NIP-46 pairing from the web login QR
- generate and protect the Android release keystore
- paste the Android signing certificate SHA-256 into
  `frontend/static/.well-known/assetlinks.json`
- set the real Apple Developer Team ID in
  `frontend/static/.well-known/apple-app-site-association`
- confirm Xcode signing, capabilities, associated domains, and archive
  upload from `frontend/ios/App/App.xcodeproj`
- run `npx cap sync ios` and `npx cap sync android` after the final web
  build for the release
