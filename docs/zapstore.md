# Zapstore release

Deepmarks publishes Android APKs to Zapstore from the public source mirror:

```text
https://github.com/ostermayer/deepmarks-public
```

The Zapstore developer identity is the public Deepmarks Nostr profile:

```text
npub199zwj9d6w88slsvlthdqfr8q2w58cq0aw3utz7fnpgt7mjjvut6qc80sqk
```

The matching secret key stays local and must never be committed. The
`zapstore.yaml` file in the repository root is committed so Zapstore can
verify the publishing pubkey against the public repository.

## Build the APK and AAB

Android needs a local Java runtime and Android SDK. From the frontend:

```bash
cd frontend
npm run build
npx cap sync android
```

For client-bundle fixes, especially private archive key/open/save fixes,
verify the APK was built after the fixing commit. A server deploy does
not update Zapstore users; publishing an APK built from an older commit
will leave the installed Zapstore app with the old client behavior.

Open `frontend/android` in Android Studio, create or select the release
keystore, then build a signed release APK. The path expected by
`zapstore.yaml` is:

```text
frontend/android/app/build/outputs/apk/release/app-release.apk
```

For a command-line release build that also creates the Play Console AAB:

```bash
cd frontend/android
./gradlew clean :app:assembleRelease :app:bundleRelease
```

The AAB lands at:

```text
frontend/android/app/build/outputs/bundle/release/app-release.aab
```

Do not commit `.jks`, `.keystore`, `local.properties`, generated APKs,
generated AABs, Gradle build output, or generated Capacitor web assets.

The Android screenshots used by Play and Zapstore live in:

```text
screenshots/android/phone/
screenshots/android/7-inch-tablet/
screenshots/android/10-inch-tablet/
```

`zapstore.yaml` references the phone screenshots. The original iOS
captures are preserved in `screenshots/ios/`.

## Publish

Install `zsp`:

```bash
go install github.com/zapstore/zsp@latest
```

Zapstore's `zsp` CLI supports local APK files, local screenshot paths,
and signing with a private key, NIP-46 bunker, or browser extension. For
Deepmarks, the publisher key is stored locally at:

```bash
publicprofile-nsec.txt
```

That file is ignored by Git and must never be committed. Use the helper
so the nsec does not land in shell history:

```bash
./scripts/zapstore-publish.sh check
./scripts/zapstore-publish.sh publish
```

In non-interactive shells, use:

```bash
./scripts/zapstore-publish.sh publish --quiet --skip-preview --overwrite-release
```

To create signed events without uploading or publishing:

```bash
./scripts/zapstore-publish.sh offline zapstore-events.json
```

`zsp` still receives the key through its process environment. For a
long-term unattended flow, prefer NIP-46 bunker signing:

```bash
SIGN_WITH="bunker://pubkey?relay=wss://relay.example.com&secret=..." zsp publish -y zapstore.yaml
```

Browser signing is also supported when a NIP-07 signer has the public
profile key available:

```bash
SIGN_WITH=browser zsp publish zapstore.yaml
```

On first publish, `zsp` may ask to link the APK signing certificate to
the Nostr publisher identity. That proof is expected and ties future
updates to the same Android signing key.

## Public mirror checklist

Before publishing:

```bash
./scripts/publish-public.sh --dry-run --keep-export
```

Inspect the exported path printed by the script, then publish the public
mirror:

```bash
./scripts/publish-public.sh -m "Prepare Deepmarks public release"
```

Zapstore whitelisting requires the committed `zapstore.yaml` in
`deepmarks-public` and the signing key used by `SIGN_WITH` to match its
`pubkey` field.
