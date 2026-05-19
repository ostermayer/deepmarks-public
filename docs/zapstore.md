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

## Build the APK

Android needs a local Java runtime and Android SDK. From the frontend:

```bash
cd frontend
npm run build
npx cap sync android
```

Open `frontend/android` in Android Studio, create or select the release
keystore, then build a signed release APK. The path expected by
`zapstore.yaml` is:

```text
frontend/android/app/build/outputs/apk/release/app-release.apk
```

Do not commit `.jks`, `.keystore`, `local.properties`, generated APKs,
Gradle build output, or generated Capacitor web assets.

## Publish

Install `zsp`:

```bash
go install github.com/zapstore/zsp@latest
```

Prefer browser or bunker signing. Avoid placing the raw `nsec` in shell
history or shared process environments.

```bash
SIGN_WITH=browser zsp publish zapstore.yaml
```

For CI or unattended publishing, use a NIP-46 bunker URL stored as a
secret:

```bash
SIGN_WITH="bunker://pubkey?relay=wss://relay.example.com&secret=..." zsp publish -y zapstore.yaml
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
