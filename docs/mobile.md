# Mobile Apps

The mobile apps are open-source Capacitor builds of the same frontend
experience. They share the Nostr bookmark model with the web app and
browser extensions.

Native source lives in:

- `frontend/ios/App/App.xcodeproj`
- `frontend/android`

The public mirror keeps both native shells so the website, extension,
iOS app, and Android app can be audited and rebuilt from source.

## Account Creation

iOS and Android can create or import Nostr identities. The recovery key
is still the user's long-term account root and must be backed up.

Passkey unlock is supported where the platform authenticator supports
the required WebAuthn behavior. Browser- or password-manager-specific
limitations can still prevent the WebAuthn PRF path from appearing.

## Bookmarking

Mobile users can save, view, search, tag, import, and export bookmarks
through the same Nostr event shapes:

- public bookmarks: `kind:39701`
- private bookmarks: encrypted `kind:30003`

The app should stay interoperable with the website and browser
extensions because the data is Nostr-native.

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

The current NIP-46 signer service runs while the app process is alive.
Background/push-assisted signing is a separate release layer and should
not be assumed for the first store submission.

## Release Gates

Before mobile store submission:

- test Android install, login, save, signer key storage, NIP-46 pairing,
  and NIP-55 request approval on a real device
- generate and protect the Android release keystore
- paste the Android signing certificate SHA-256 into
  `frontend/static/.well-known/assetlinks.json`
- set the real Apple Developer Team ID in
  `frontend/static/.well-known/apple-app-site-association`
- confirm Xcode signing, capabilities, associated domains, and archive
  upload from `frontend/ios/App/App.xcodeproj`
- run `npx cap sync ios` and `npx cap sync android` after the final web
  build for the release
