# iOS Share Extension setup (one-time, in Xcode)

The SvelteKit `/app/save?url=…` route, the Capacitor `appUrlOpen`
listener (`src/lib/native/deep-links.ts`), and the `deepmarks://`
URL scheme (declared in `App/App/Info.plist`) are all wired. The
last piece is the Share Extension target itself — which Apple
requires to be created through Xcode's UI because it scaffolds the
target's plist, entitlements, and build phases atomically.

## What you'll be doing

Adding a new target named `DeepmarksShare` that accepts shared URLs
from any iOS app (Safari, Mail, Messages, …) and re-opens our host
app at `deepmarks://save?url=…`. The host app's `appUrlOpen`
listener routes that to `/app/save` and the SvelteKit form prefills.

## Step-by-step

1. Open the Xcode project:
   ```
   open frontend/ios/App/App.xcodeproj
   ```

2. **File → New → Target…**
   - Filter: "Share Extension"
   - Pick **Share Extension**
   - Click **Next**

3. Fill in the wizard:
   - Product Name: `DeepmarksShare`
   - Team: your Apple Developer team
   - Language: **Swift**
   - Embed in Application: **App**
   - Click **Finish**
   - When asked "Activate scheme?" — say **Cancel** (we're not
     building the share scheme directly)

4. Xcode generates `DeepmarksShare/`. Replace the body of
   `DeepmarksShare/ShareViewController.swift` with the contents of
   this file (alongside this README): `ShareViewController.swift`.

5. Open `DeepmarksShare/Info.plist` and update the `NSExtensionAttributes`
   so the share sheet only shows Deepmarks for URLs (we don't want
   Deepmarks to appear when sharing photos or text). Replace the
   existing `NSExtensionAttributes` entry with:

   ```xml
   <key>NSExtensionAttributes</key>
   <dict>
       <key>NSExtensionActivationRule</key>
       <dict>
           <key>NSExtensionActivationSupportsWebURLWithMaxCount</key>
           <integer>1</integer>
           <key>NSExtensionActivationSupportsWebPageWithMaxCount</key>
           <integer>1</integer>
       </dict>
   </dict>
   ```

6. The bundle identifier for the Share Extension is automatically
   set to `org.deepmarks.app.DeepmarksShare`. Don't change it; this
   has to live under the parent app's bundle ID.

7. **Signing & Capabilities** for the new target:
   - Set **Team** to your Apple Developer team
   - The signing certificate auto-fills

8. Build and run on a simulator or device:
   - Run the **App** scheme (`Product → Run`)
   - Once installed, open Safari, browse to any page, hit Share
   - Scroll the share sheet to find **Deepmarks**
   - Tap it — the host app should open at the bookmark form prefilled

## What `ShareViewController.swift` does

Reads the shared item's URL (the share extension API hands us an
`NSItemProvider` containing a `URL`), then opens the host app with
`deepmarks://save?url=<encoded>`. The host app's `AppDelegate`
forwards that URL to Capacitor's `App.appUrlOpen` event listener,
which our deep-link router catches and uses to navigate the
SvelteKit webview to `/app/save?url=…`.

The Share Extension is intentionally minimal — no UI, no input
field, no buttons. Apple requires `SLComposeServiceViewController`
to subclass to render *something*, but we override `viewDidAppear`
to immediately complete the request and open the host app, so the
user only sees a brief flash of the share sheet's preview UI before
landing in our app.

## App Store metadata note

The Share Extension shows up in the App Store listing as a separate
"capability" (look for "URL Identification" or "Sharing" in the
review screen). No additional disclosures needed beyond what the
parent app already declares.
