# iOS Universal Links setup (one-time, in Xcode)

Universal Links let `https://deepmarks.org/app/save?url=…` open the
installed app instead of the browser. Required because the iOS
Share Extension hands us a `deepmarks://` URL, but other apps
sharing a deepmarks.org link (Mail, Notes, Slack) will pass the
`https://` form — and we want both flows to land on `/app/save`.

## What's already wired

- `frontend/static/.well-known/apple-app-site-association` —
  declares which paths the app handles. **Edit this file to
  replace `TEAMID` with your 10-character Apple Developer Team
  identifier** (find it at developer.apple.com → Membership).
  Cloudflare Pages serves it as `application/json` (configured in
  `static/_headers`) at the no-extension URL Apple requires.
- `frontend/src/lib/native/deep-links.ts` — already parses the
  `https://deepmarks.org/app/save?url=…` shape uniformly with the
  custom-scheme variant. No JS changes needed.

## What you'll do in Xcode

1. Open `frontend/ios/App/App.xcodeproj`.
2. Select the **App** target → **Signing & Capabilities**.
3. Click **+ Capability** → **Associated Domains**.
4. In the new section, click **+** and add:
   ```
   applinks:deepmarks.org
   ```
5. Xcode auto-creates `App/App/App.entitlements` with the
   `com.apple.developer.associated-domains` key. Commit that file.

## Verify it's working

After installing the app on a real iPhone:

1. In Notes or Messages, tap-and-hold the link
   `https://deepmarks.org/app/save?url=https%3A%2F%2Fexample.com`
2. The "Open in Deepmarks" option should appear.
3. Tap it — the app launches at the bookmark form prefilled.

If the Open-in option doesn't appear, the iPhone may have cached
a previous "no app for this domain" answer. Reset by:
- Deleting the app
- Rebooting the device
- Reinstalling

Apple's CDN refetches the apple-app-site-association on every install,
so a TEAMID rotation propagates within minutes.

## Cross-platform note

Android's equivalent (App Links) is already wired:
- `frontend/static/.well-known/assetlinks.json` declares the
  package + signing-cert fingerprint. **Replace
  `REPLACE_WITH_SIGNING_CERT_SHA256_FINGERPRINT` with the SHA-256
  of the release signing key.** Get the fingerprint with:
  ```sh
  keytool -list -v -keystore <release-keystore.jks> -alias <alias>
  ```
- `android/app/src/main/AndroidManifest.xml` already has the
  `<intent-filter android:autoVerify="true">` for
  `https://deepmarks.org/app/save`.

Until the fingerprint is real, Android's autoVerify will fail and
the URL falls back to a chooser dialog — which is the right
behavior (non-app users get the website).
