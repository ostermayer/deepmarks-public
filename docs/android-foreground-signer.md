# Android Foreground Signer

Implementation notes for the Android app's Amber-like mobile signer.
Deepmarks supports NIP-46 pairing, Android NIP-55 signing entry points,
and an opt-in native foreground service that keeps NIP-46 relay
subscriptions alive while the app is backgrounded.

## Goal

Keep the Deepmarks mobile signer available for paired NIP-46 clients
even when the user leaves the app, without hiding the fact that a
signer is running.

User-facing behavior:

- Android shows a **Keep mobile signer running** toggle on
  `/app/mobile-signer`.
- When enabled, Android shows a persistent Deepmarks signer
  notification.
- NIP-46 clients can connect using `nostrconnect://...` links and send
  signing requests while the Deepmarks app is not the foreground
  screen.
- Native Android Nostr apps can continue using the existing
  `nostrsigner:` NIP-55 approval flow.
- Deepmarks itself can log in through another Android NIP-55 signer
  such as Amber or Primal, storing only that signer's package name and
  public key. The login picker lists external signer apps in Deepmarks
  and filters out Deepmarks' own package so the app cannot choose itself
  while logged out.
- Trusted NIP-55 clients can receive remembered app-level approval:
  full trust signs all supported requests, medium trust auto-approves
  common auth/public-key requests, and low trust asks for each request.
- Users can stop the service from settings or from the Android
  notification.

## Non-goals

- Do not make background signing silent or invisible. Android
  foreground-service policy requires a user-visible notification.
- Do not weaken key isolation. The nsec remains encrypted with the
  Android Keystore-backed native secure store.
- Do not replace the web, iOS, or browser-extension signer paths.
- Do not auto-approve signing requests by default. Remembered approval
  policies can come later and must be explicit.
- Do not claim full iOS parity. iOS background execution rules are
  different; iOS currently signs while the app is open.

## Current State

Implemented pieces:

- `frontend/android/app/src/main/AndroidManifest.xml`
  - handles `nostrconnect:`, `bunker:`, `nostrsigner:`, `deepmarks:`,
    and selected `https://deepmarks.org/...` app links.
  - declares `Nip46ForegroundService`, foreground-service permissions,
    and notification permission.
- `frontend/android/app/src/main/java/org/deepmarks/app/MainActivity.java`
  - normalizes incoming `nostrsigner:` requests into the in-app signer
    review screen.
  - registers the native `DeepmarksNip46Service` Capacitor plugin.
- `frontend/android/app/src/main/java/org/deepmarks/app/NostrSignerIntentStore.java`
  - persists one pending NIP-55 request for review/completion.
- `frontend/android/app/src/main/java/org/deepmarks/app/NostrSignerProvider.java`
  - exposes the Android NIP-55 content-provider methods used by
    compatible apps such as Amethyst.
- `frontend/android/app/src/main/java/org/deepmarks/app/DeepmarksSecureStorePlugin.java`
  - exposes the Capacitor bridge for both directions: completing
    incoming signer requests and connecting/calling external Android
    NIP-55 signers for Deepmarks login.
- `frontend/src/lib/nostr/signers/android.ts`
  - implements the web-side NDK signer wrapper for external Android
    signers. It uses content-provider calls first and falls back to
    foreground `nostrsigner:` approval.
- `frontend/android/app/src/main/java/org/deepmarks/app/NostrSignerActions.java`
  - executes native NIP-55 signing, encryption/decryption, and private
    zap helper behavior.
- `frontend/android/app/src/main/java/org/deepmarks/app/NostrSignerTrustStore.java`
  - stores per-requesting-app trust levels for remembered Android
    signer approvals.
- `frontend/android/app/src/main/java/org/deepmarks/app/NostrBech32.java`
  - owns reusable Bech32 encode/decode helpers for private zap payloads.
- `frontend/android/app/src/main/java/org/deepmarks/app/NativeSecureValueStore.java`
  - encrypts app secrets using an Android Keystore AES key.
- `frontend/android/app/src/main/java/org/deepmarks/app/NostrNativePublisher.java`
  - already loads the mobile signer nsec, derives the public key,
    builds canonical Nostr events, signs BIP-340/Schnorr events, and
    builds NIP-98 auth for the Android share-sheet fast path.
- `frontend/src/lib/mobile/nip46-service.ts`
  - starts the native foreground service when enabled and falls back to
    the JavaScript NIP-46 listener while the app process is alive.
- `frontend/src/routes/app/mobile-signer/+page.svelte`
  - surfaces the Android-only background signer toggle and service
    status.

- `NostrEventSigner` is extracted from the Android share-sheet
  publisher and covered by JVM tests for canonical event IDs and
  Schnorr signatures.
- `NostrCrypto` owns reusable secp256k1, SHA-256, HMAC-SHA256, HKDF,
  and constant-time comparison helpers.
- `NostrNip44` implements native NIP-44 v2 envelope encryption and
  decryption using pure-Java ChaCha20 so it does not depend on newer
  Android cipher providers.
- `NostrNip04` implements native NIP-04 AES-CBC encrypt/decrypt for
  NIP-46 helper-method parity.
- `NostrNip44Test` checks native output against `nostr-tools` vectors:
  shared conversation key, deterministic payload, decrypt result, MAC
  rejection, and padding buckets.
- `NostrCrypto.schnorrVerify` verifies BIP-340 signatures over 32-byte
  event IDs and is covered by the native event signer tests.
- `NostrJson` provides the small JSON parser/writer needed by the
  native signer path so request handling is testable in JVM unit tests
  without Android's stubbed `org.json` classes.
- `NostrNip46RequestHandler` now handles one already-fetched NIP-46
  request offline: verifies the event id/signature, checks the signer
  `p` tag and paired client pubkey, decrypts NIP-44 content,
  permission-checks the method, and returns an encrypted kind:24133
  response for `connect`, `get_public_key`, `ping`, `switch_relays`,
  `sign_event`, `nip04_encrypt`, `nip04_decrypt`, `nip44_encrypt`,
  and `nip44_decrypt`.
- `NostrNip46RequestHandlerTest` covers successful `ping`, successful
  authorized `sign_event`, helper encryption/decryption methods,
  encrypted unauthorized errors, and rejecting tampered events before
  decrypting.
- `Nip46ConnectionStore` mirrors the JS connection/account storage in
  Android secure storage.
- `Nip46RelayClient` owns native WebSocket relay subscription,
  publishing, and reconnect backoff.
- `Nip46ForegroundService` owns notification lifecycle, relay clients,
  request dispatch, dedupe, and stop action.
- `Nip46ServiceControllerPlugin` exposes `setEnabled`, `refresh`, and
  `status` to the Svelte UI.

## Product Model

The feature should be presented as an advanced Android-only signer
option, not as a required app behavior.

Settings copy:

```
Keep mobile signer running
Allow paired NIP-46 clients to request signatures while Deepmarks is in
the background. Android will show a persistent signer notification.
```

States:

| State | UI copy | Behavior |
|---|---|---|
| No mobile signer key | Add a recovery key first | Toggle disabled |
| No paired clients | Pair a client first | Toggle disabled or starts idle |
| Enabled and connected | Signer running | Notification visible, relay subscriptions active |
| Enabled but reconnecting | Reconnecting | Notification visible, exponential backoff |
| Disabled | Signer stopped | No foreground notification |
| User stopped from notification | Signer stopped | Persist disabled state |

Notification:

- Title: `Deepmarks signer running`
- Body connected: `Listening for paired NIP-46 requests`
- Body reconnecting: `Reconnecting to signer relays`
- Actions: `Open`, `Stop`
- Tapping opens `/app/mobile-signer`.

## Native Architecture

Implemented Android classes:

| Class | Responsibility |
|---|---|
| `Nip46ForegroundService` | Android `Service`; owns lifecycle, notification, relay sockets, reconnect timer, and request dispatch. |
| `Nip46ConnectionStore` | Native mirror of the JS connection store at `deepmarks-mobile-signer-connections:v1`. Parses and validates paired clients. |
| `NostrNip46RequestHandler` | Decrypts kind:24133 requests, permission-checks, executes methods, and produces encrypted responses. |
| `Nip46RelayClient` | WebSocket client for `REQ`, `EVENT`, `CLOSE`, reconnect, and publish acks. |
| `NostrCrypto`, `NostrNip44`, `NostrNip04` | NIP-44, NIP-04, BIP-340 signing, public-key derivation, and conversation-key helpers. |
| `Nip46ServiceControllerPlugin` | Capacitor plugin methods for start/stop/status from the Svelte settings screen. |
| `Nip46BootReceiver` | Optional later phase: restart only if the user enabled the service before reboot and Android permits it. |

Preferred package: continue using `org.deepmarks.app`.

## Data Model

Reuse existing secure-store keys so the JS and native signer see the
same account and pairings:

- account: `deepmarks-mobile-signer-account:v1`
- pairings: `deepmarks-mobile-signer-connections:v1`

Account shape:

```json
{
  "schemaVersion": 1,
  "pubkey": "<hex pubkey>",
  "nsecHex": "<hex secret>",
  "createdAt": 0,
  "updatedAt": 0
}
```

Connection shape:

```json
{
  "id": "<client pubkey>",
  "clientPubkey": "<hex pubkey>",
  "relays": ["wss://..."],
  "secret": "<nostrconnect secret>",
  "perms": ["sign_event", "nip44_encrypt"],
  "name": "Client name",
  "url": "https://client.example",
  "image": "https://client.example/icon.png",
  "createdAt": 0,
  "lastSeenAt": 0
}
```

The native service must tolerate unknown fields and invalid entries.
Invalid entries should be skipped, not crash the service.

## Protocol Behavior

The native service should match the JS implementation in
`frontend/src/lib/mobile/nip46-service.ts`.

Relay subscription:

- subscribe to `kind:24133`
- filter `#p` to the user's signer pubkey
- subscribe across the union of relays from paired clients

Request handling:

1. Verify event signature.
2. Find pairing by `event.pubkey`.
3. Decrypt content with NIP-44 conversation key between signer nsec and
   client pubkey.
4. Parse `{ id, method, params }`.
5. Permission-check against the pairing's `perms`.
6. Execute method.
7. Encrypt response with the same NIP-44 conversation key.
8. Publish response as kind:24133 with `p` tag set to the client pubkey.
9. Touch `lastSeenAt`.

Supported methods for parity:

| Method | Status | Notes |
|---|---|---|
| `connect` | Implemented | Return secret/ack as current JS behavior does. |
| `get_public_key` | Implemented | Return signer pubkey. |
| `ping` | Implemented | Return `pong`. |
| `switch_relays` | Implemented | Return preferred relay list. |
| `sign_event` | Implemented | Parse event template, sign canonical event, return signed JSON. |
| `nip44_encrypt` | Implemented | Uses native NIP-44 v2 implementation. |
| `nip44_decrypt` | Implemented | Uses native NIP-44 v2 implementation. |
| `nip04_encrypt` | Implemented | Uses native NIP-04 AES-CBC implementation. |
| `nip04_decrypt` | Implemented | Uses native NIP-04 AES-CBC implementation. |
| `decrypt_zap_event` | Implemented for NIP-55 | Decrypts private zap events where the signer controls the recipient key or derived private-zap key. |

Unsupported or unauthorized methods must return an error response rather
than crashing or leaking plaintext. NIP-46 responses are encrypted;
NIP-55 responses use the Android signer result/error path.

Requests are deduped by event id in the service so the same request
seen on multiple relays only signs once per process lifetime. The
current dedupe set is bounded to avoid unbounded memory growth.

## Android Foreground-Service Requirements

Android foreground services are intended for user-noticeable work and
must show a status-bar notification. The Deepmarks signer qualifies
only when the user has explicitly enabled background signing and
understands that the app is listening for signing requests.

Implementation details:

- `AndroidManifest.xml` declares `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_DATA_SYNC`, `POST_NOTIFICATIONS`, and the
  service type `dataSync`.
- `Nip46ForegroundService` calls `startForeground()` before loading
  relays.
- The notification stop action stops the service and persists the
  disabled setting.
- The app starts the foreground service from explicit user/UI flows or
  foreground app startup when the setting is already enabled.
- Expect Google Play foreground-service declarations/questionnaire
  during release.

References:

- Android foreground services overview:
  https://developer.android.com/develop/background-work/services/fgs
- Android foreground service types:
  https://developer.android.com/develop/background-work/services/fgs/service-types
- Android background-start restrictions:
  https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start

## Crypto

The native signer path uses:

- `NativeSecureValueStore` for the account nsec and paired-client list.
- `NostrCrypto` for secp256k1, x-only pubkey derivation, SHA-256,
  HMAC/HKDF, shared secret, and constant-time comparison helpers.
- `NostrEventSigner` for canonical Nostr serialization, event id
  hashing, and BIP-340/Schnorr signing.
- `NostrNip44` for the mandatory NIP-46 request/response envelope and
  helper methods.
- `NostrNip04` for helper-method parity with the JS signer.

The native crypto path is covered by JVM tests against known vectors
and cross-checks with the JavaScript `nostr-tools` behavior where
practical.

## Security Model

Primary risks:

- A malicious client pairs and requests broad signatures.
- A paired client requests unexpected event kinds.
- A background service signs when the user forgot it was enabled.
- Relay traffic metadata reveals that the signer is online.
- Native crypto bug signs or decrypts incorrectly.

Controls:

- Pairing is explicit. No client gets access without `nostrconnect`
  pairing.
- Permission allowlist per pairing remains mandatory.
- NIP-55 trust is explicit per requesting Android package. Low trust
  asks every time, medium trust auto-approves common auth/public-key
  requests, and full trust signs all supported requests from that app.
- Display paired client name and permissions in settings.
- The "remove client" action restarts the signer and future requests
  from that client are ignored.
- Android app permissions can be changed or revoked from the mobile
  signer screen.
- Persistent notification while background signer is running.
- Never expose nsec to WebView localStorage or logs.

Future controls:

- Log recent request metadata locally without storing plaintext private
  content.
- Rate-limit repeated invalid requests per client pubkey.

Approval policy:

- NIP-46 paired-client permissions come from the pairing request and
  remain method-scoped.
- NIP-55 Android app trust is user-selected on first approval and can
  be changed later from the mobile signer screen.
- Never silently grant a new Android app full trust without an explicit
  user choice.

## User Experience

Settings should make the difference between NIP-55 and NIP-46 clear:

- NIP-55: other Android apps open Deepmarks for a one-off approval.
- NIP-46 foreground service: paired clients can reach Deepmarks through
  relays while the app is in the background.
- Android app permissions: remembered NIP-55 trust for each requesting
  package, independent from NIP-46 paired-client permissions.

Suggested section layout:

1. Mobile signer key status.
2. Paired clients.
3. Background signer toggle.
4. Service status.
5. Recent requests.

Avoid phrases like "daemon" or "foreground service" in primary user
copy. Use "Keep signer running" and explain that Android will show a
notification.

## Implementation Phases

### Phase 0 - Preparation

- Extract native signing helpers out of `NostrNativePublisher`. Done.
- Add Java/Kotlin unit tests for canonical event id and Schnorr signing. Done.
- Add a native JSON helper for deterministic Nostr serialization. Done.
- Add a small native status bridge to the Svelte settings screen. Done.

Exit criteria:

- Existing Android share-sheet native publish still signs and posts.
- Native event-signing tests pass.

### Phase 1 - Foreground Service and NIP-46 Signing

- Add `Nip46ForegroundService`. Done.
- Add notification channel and persistent notification. Done.
- Add start/stop actions. Done.
- Add native relay WebSocket client. Done.
- Add native NIP-44 v2 envelope decrypt/encrypt with known-vector tests. Done.
- Subscribe to paired relays. Done.
- Support `connect`, `get_public_key`, `ping`, `switch_relays`, and
  `sign_event`. Done.
- Surface service status in `/app/mobile-signer`. Done.

Exit criteria:

- Deepmarks web can pair with Android phone signer.
- The browser can request a kind:1 signature while Deepmarks is in the
  background and the service notification is visible.
- Service reconnects after relay drop.
- Stopping notification disables service.

### Phase 2 - Encryption Helper Method Parity

- Add native NIP-04 support. Done.
- Add tests for the exposed helper methods. Done.
- Support `nip44_encrypt`, `nip44_decrypt`, `nip04_encrypt`,
  `nip04_decrypt`. Done.
- Confirm parity with current JS signer responses. Done in JVM tests.

Exit criteria:

- All methods currently supported by JS NIP-46 service are supported
  natively.
- Test vectors pass.
- Manual test with at least one third-party NIP-46 client passes.

### Phase 3 - Lifecycle Hardening

- Add optional boot/package-replaced restart if the user enabled the
  service.
- Add network-change reconnect.
- Add request-rate limiting.
- Add local request history.
- Add battery-optimization guidance only if real-device testing shows
  it is necessary.

Exit criteria:

- App update does not leave the service in a broken state.
- Device reboot behavior is predictable and documented.
- Battery impact is acceptable in a 24-hour real-device test.

### Phase 4 - Release

- Update Android release notes.
- Update Google Play foreground-service declaration.
- Update Zapstore release notes.
- Add screenshots or help text if settings UX changes materially.
- Run real-device tests before submission.

## Testing Checklist

Automated:

- Native signing known vectors. Covered by JVM tests.
- Nostr canonical serialization. Covered by JVM tests.
- NIP-46 request parse/decrypt/response encode. Covered by JVM tests.
- Permission allowlist accepts and rejects expected methods/kinds. Covered by JVM tests.
- Native NIP-44/NIP-04 helper method parity. Covered by JVM tests.
- Relay client reconnect/backoff unit tests where practical.

Manual Android device tests:

- Import nsec.
- Pair Deepmarks web login QR.
- Enable background signer.
- Press home and confirm persistent notification.
- Sign from paired browser while app is backgrounded.
- Stop service from notification.
- Remove paired client and confirm requests fail.
- Toggle service off/on.
- Kill app from recents and confirm expected behavior.
- Reboot device if Phase 3 is implemented.
- Test on Android 13, 14, 15, and current target SDK device.

Regression tests:

- Android share-sheet save still works.
- Android NIP-55 `nostrsigner:` flow still opens approval UI.
- Trusted Android NIP-55 apps do not bounce repeatedly after a remembered
  trust decision.
- Low-trust Android NIP-55 apps still require per-request approval.
- Normal app login/logout remains unchanged.
- iOS build is unaffected by Android-only code.
- Web build is unaffected.

## Release and Store Impact

Android app resubmission is required because this changes native code,
manifest permissions, and Play policy declarations.

Zapstore APK resubmission is required for the same reason.

iOS resubmission is not required for Android-only signer changes. It is
required when shared web UI changes, icons, splash assets, or iOS version
metadata change inside the Capacitor bundle.

Browser extension resubmission is not required.

## Remaining Questions

- Confirm Google Play's accepted foreground-service declaration text
  for a user-enabled signer using `dataSync`.
- Should service enablement require a PIN/biometric confirmation?
- Do we need per-client request history before first release?
- Which third-party NIP-46 clients should be part of the manual
  compatibility matrix?

## Current Decision

Ship the feature as opt-in, visible, and easy to stop. Android
resubmission is required because the implementation changes native
code, manifest permissions, notification behavior, and store policy
answers. iOS is unaffected except for shared web copy included in the
Capacitor bundle.
