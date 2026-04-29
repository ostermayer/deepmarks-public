# Safari (macOS + iOS) build

The same `dist/` JS bundle that ships to Chrome and Firefox is wrapped
in a tiny Xcode project so it can be installed as a Safari Web
Extension on macOS and iOS. The wrapper adds a **native messaging
host** that handles Keychain reads/writes — that's how the Safari
build gets persistent + biometric-gated nsec storage instead of
`browser.storage.local` plaintext.

## File layout

```
safari/
├── README.md                          # this file
├── KeychainBridge.swift               # native messaging host (drop into the Xcode native target)
├── Info.plist.fragment.xml            # extension Info.plist additions
└── README-userflow.md                 # what the user experiences
```

## One-time setup (per dev machine)

1. Install Xcode (15+ for iOS 17 / macOS 14 minimum).
2. Have an Apple Developer account ($99/yr) — required to ship to either App Store.
3. From the repo root:

   ```bash
   cd browser-extension
   npm install
   npm run build:chrome           # produces dist/ — Safari uses the same MV3 bundle
   ```

## Generate the Xcode project

Apple ships a CLI that converts a built MV3 extension into an Xcode
project skeleton:

```bash
xcrun safari-web-extension-converter dist/ \
  --project-location safari/ \
  --bundle-identifier org.deepmarks.extension \
  --app-name Deepmarks \
  --copy-resources \
  --no-prompt
```

This generates `safari/Deepmarks/` with two Xcode targets:
- `Deepmarks` — the host app (containing app shell that ships to App Store)
- `Deepmarks Extension` — the Safari extension itself

## Wire up the Keychain native bridge

The generated Xcode project doesn't include the Keychain bridge by
default. Add it manually (one-time per project regen):

1. Open `safari/Deepmarks/Deepmarks.xcodeproj` in Xcode.
2. Add `KeychainBridge.swift` (in this directory) to the
   `Deepmarks Extension` target.
3. In the extension's `Info.plist`, append the keys from
   `Info.plist.fragment.xml` under `NSExtension > NSExtensionAttributes`.
4. In Xcode, under "Signing & Capabilities" for both targets:
   - Set Team to your Apple Developer team
   - Add the **Keychain Sharing** capability (group:
     `org.deepmarks.extension.keychain`) so the extension and host
     app share the same Keychain item

## Build & run

```bash
# In Xcode:
#   Product → Run (⌘R)         # macOS host app, includes the extension
#   Product → Destination → iOS Simulator → Run    # iOS host
```

On macOS: open Safari → Preferences → Extensions → enable "Deepmarks".
On iOS Simulator: Settings → Safari → Extensions → enable "Deepmarks".

## Distribution

Both macOS and iOS use the same Xcode project with two schemes. To
ship:

```bash
# macOS Mac App Store
Product → Archive → Distribute App → Mac App Store Connect

# iOS App Store
Select iOS scheme → Product → Archive → Distribute App → App Store Connect
```

Apple review takes ~1–3 days for new extensions, ~1 day for updates.

## Threat model recap

| Platform | nsec storage | Re-entry | Encryption |
|---|---|---|---|
| Chrome / Firefox | `browser.storage.local` plaintext | none | none |
| **Safari macOS** | **Keychain (Secure Enclave when available)** | **none** | **OS-managed AES-GCM** |
| **Safari iOS** | **Keychain + Secure Enclave** | **none (biometric-gated read on first popup open)** | **OS-managed** |

The same `lib/nsec-store.ts` facade abstracts both. On Safari, JS
detects the runtime via `navigator.userAgent` and routes
`get/set/clear` through `browser.runtime.sendNativeMessage` to the
native KeychainBridge. On other browsers it stays in
`browser.storage.local`.
