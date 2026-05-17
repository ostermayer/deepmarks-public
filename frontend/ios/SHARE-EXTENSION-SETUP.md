# iOS Share Extension setup

The SvelteKit `/app/save?url=…` route, the Capacitor `appUrlOpen`
listener (`src/lib/native/deep-links.ts`), and the `deepmarks://`
URL scheme (declared in `App/App/Info.plist`) are all wired. The
`DeepmarksShare` target is also checked into the Xcode project and is
embedded in the main app.

## What the extension does

`DeepmarksShare` accepts shared URLs and plain-text URL shares from any
iOS app (Safari, Mail, Messages, etc.). It first stores the save request
in the shared App Group queue, then re-opens the host app at
`deepmarks://save?pendingShareId=…`. The host app's `appUrlOpen`
listener routes that to `/app/save`, the SvelteKit form loads the queued
payload, and the app signs/publishes it when the local signer is ready.

If iOS does not launch the host app immediately, the queued request
stays in the App Group container and is picked up the next time
Deepmarks opens.

## Step-by-step

1. Register two Apple App IDs in the Apple Developer portal:

   ```text
   org.deepmarks.app
   org.deepmarks.app.DeepmarksShare
   ```

2. Open the Xcode project:
   ```
   open frontend/ios/App/App.xcodeproj
   ```

3. **Signing & Capabilities** for the **App** target:
   - Set **Team** to your Apple Developer team
   - Enable **Associated Domains**
   - Add `applinks:deepmarks.org`
   - Enable **App Groups**
   - Add `group.org.deepmarks.app.shared`

4. **Signing & Capabilities** for the **DeepmarksShare** target:
   - Set **Team** to your Apple Developer team
   - Enable **App Groups**
   - Add `group.org.deepmarks.app.shared`
   - The signing certificate auto-fills

5. Build and run on a simulator or device:
   - Run the **App** scheme (`Product → Run`)
   - Once installed, open Safari, browse to any page, hit Share
   - Scroll the share sheet to find **Deepmarks**
   - If it is hidden, tap **More…** / **Edit Actions…** and enable **Deepmarks**
   - Tap it — the host app should open at the bookmark form prefilled

## What `ShareViewController.swift` does

Reads the shared item's URL (the share extension API hands us an
`NSItemProvider` containing a `URL`, or sometimes plaintext with a URL),
offers a native Save Link form, writes the resulting payload to
`UserDefaults(suiteName: "group.org.deepmarks.app.shared")`, and then opens the
host app.

The host app exposes the same App Group queue through the
`DeepmarksSecureStore` Capacitor bridge. `/app/save` removes a queued
payload only after `saveBookmark()` succeeds. A failed relay publish or
locked signer leaves the payload available for retry.

## App Store metadata note

The Share Extension shows up in the App Store listing as a separate
"capability" (look for "URL Identification" or "Sharing" in the
review screen). No additional disclosures needed beyond what the
parent app already declares.
