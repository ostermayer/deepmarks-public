# iOS Share Extension setup

The SvelteKit `/app/save?url=…` route, the Capacitor `appUrlOpen`
listener (`src/lib/native/deep-links.ts`), and the `deepmarks://`
URL scheme (declared in `App/App/Info.plist`) are all wired. The
`DeepmarksShare` target is also checked into the Xcode project and is
embedded in the main app.

## What the extension does

`DeepmarksShare` accepts shared URLs and plain-text URL shares from any
iOS app (Safari, Mail, Messages, etc.) and shows a native Save Link form
for URL, title, description, tags, read-later, and visibility.

For public saves, the extension reads the user's nsec from the shared
Keychain access group, signs the `kind:39701` event locally, builds a
NIP-98 auth header, and POSTs the signed event to
`https://api.deepmarks.org/publish`.

For private saves, the extension signs a single encrypted `kind:30003`
private-item event named `deepmarks-private-item:<sha256(url)>`. The
content is the normal private bookmark inner tag array encrypted to the
user's own pubkey with NIP-44 v2. This avoids rewriting the full chunked
private set from an extension process, and the web/app readers merge the
item event with the older chunked `deepmarks-private*` set.

Both paths write the edited payload to the shared App Group queue with
`published: "1"`, so the host app can update local state later without
posting the event twice. Missing local keys or a native publish failure
keep the edited payload queued and open the host app at
`deepmarks://save?pendingShareId=…`. If iOS does not launch the host app
immediately, the queued request is picked up the next time Deepmarks
opens.

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
   - Tap it — the native Save Link form should open in the share sheet

## What `ShareViewController.swift` does

Reads the shared item's URL (the share extension API hands us an
`NSItemProvider` containing a `URL`, or sometimes plaintext with a URL),
offers a native Save Link form, fetches optional metadata/tag
suggestions, and writes the resulting payload to
`UserDefaults(suiteName: "group.org.deepmarks.app.shared")`.

For saves with a shared nsec available, `NostrEvent.swift` and
`NostrPublish.swift` build the canonical Nostr event id from
`[0, pubkey, created_at, kind, tags, content]`, sign with BIP-340
Schnorr, sign the NIP-98 `kind:27235` auth event, and POST `/publish`
inside the extension. Private saves use the same signing path after
encrypting the private item payload with native NIP-44 v2. The extension
then marks the queued payload as already published and dismisses.

The host app exposes the same App Group queue through the
`DeepmarksSecureStore` Capacitor bridge. For queued private or fallback
saves, `/app/save` removes a payload only after `saveBookmark()`
succeeds. For queued public payloads marked `published: "1"`, the host
app skips duplicate `/publish` and only updates local state plus archive
queueing.

## App Store metadata note

The Share Extension shows up in the App Store listing as a separate
"capability" (look for "URL Identification" or "Sharing" in the
review screen). No additional disclosures needed beyond what the
parent app already declares.
