# Public release checklist

Deepmarks is GPL-3.0-only open source. The public source mirror is:

```text
https://github.com/ostermayer/deepmarks-public
```

All app surfaces are intended to be open source:

- web frontend
- Chrome, Firefox, and Safari browser extensions
- iOS Capacitor shell
- Android Capacitor shell
- payment/API service
- archive worker
- NIP-46 bunker service
- deploy templates and docs, with private operator details sanitized

## Safe public mirror prep

The private repo can contain operator-specific deployment values. The
public mirror is produced by `scripts/publish-public.sh`, which exports
the current Git commit, removes internal prototypes, replaces known
operator IP addresses with placeholders, keeps the mobile app source,
and removes the mirror-publish script itself.

The release version comes from `frontend/package.json`. The site footer
also reads that same package version, so a public Git tag such as
`v0.4.0` corresponds to the version visible on the website.

Dry run first:

```bash
./scripts/publish-public.sh --dry-run --keep-export --tag-version -m "Prepare Deepmarks public release"
```

Inspect the printed export path:

```bash
rg -n -I 'nsec1|BEGIN (RSA|OPENSSH|PRIVATE)|172\.(238|237|234)\.' <export-path>
git -C <export-path> ls-files | rg '(^|/)(publicprofile-nsec|deepmarks-admin-nsec|.*macaroon|.*secret|.*\\.jks|.*\\.keystore|.*\\.p12)'
git -C <export-path> ls-files | rg 'frontend/android|frontend/ios|zapstore.yaml|LICENSE'
```

Only after review, push the public mirror:

```bash
./scripts/publish-public.sh --tag-version -m "Prepare Deepmarks public release"
```

That force-pushes `main` on `ostermayer/deepmarks-public`; do not run
it until the exported tree has been inspected.

To create the matching GitHub Release at the same time:

```bash
./scripts/publish-public.sh --tag-version --github-release -m "Prepare Deepmarks public release"
```

That requires a working GitHub CLI login. On a laptop, run:

```bash
gh auth login --web --scopes repo
gh auth status
```

Choose `GitHub.com` and the same account that can administer
`ostermayer/deepmarks-public`. If `gh auth login` says you are already
logged in but `gh auth status` still reports an invalid token, refresh or
replace the stored credential:

```bash
gh auth refresh -h github.com -s repo
# if refresh does not fix it:
gh auth logout -h github.com -u ostermayer
gh auth login --web --scopes repo
```

If you already pushed the git tag but the Release object is missing,
create it later from the existing tag:

```bash
gh release create v0.4.0 \
  --repo ostermayer/deepmarks-public \
  --title "Deepmarks v0.4.0" \
  --notes "Initial GPL-3.0 public release."
```

The script refuses to overwrite an existing remote tag. If `vX.Y.Z`
already exists, bump `frontend/package.json` before publishing the next
public release milestone.

## License

The repository uses GPL-3.0-only:

- root `LICENSE` contains the GPLv3 license text
- package manifests declare `GPL-3.0-only`
- `zapstore.yaml` declares `license: GPL-3.0-only`

## Android

Source folder:

```text
frontend/android
```

Prep:

```bash
cd frontend
npm run build
npx cap sync android
```

Build and sign the release APK in Android Studio after testing on a
real device. Keep `.jks`, `.keystore`, `.p12`, `local.properties`,
generated APKs, and generated web assets out of Git.

Before public release, update:

```text
frontend/static/.well-known/assetlinks.json
```

with the SHA-256 fingerprint of the final Android release signing
certificate.

## iOS

Source project:

```text
frontend/ios/App/App.xcodeproj
```

Prep:

```bash
cd frontend
npm run build:apple
npx cap sync ios
```

Before App Store submission, configure the Apple Developer Team,
signing, associated domains, and any required capabilities in Xcode.
Then replace `TEAMID` in:

```text
frontend/static/.well-known/apple-app-site-association
```

The iOS project should not include personal provisioning profiles or
per-user Xcode state.

## Zapstore

Do not publish to Zapstore until the Android APK has been installed and
tested manually.

Prepared files:

- `zapstore.yaml`
- `docs/zapstore.md`

The Zapstore publisher identity is:

```text
npub199zwj9d6w88slsvlthdqfr8q2w58cq0aw3utz7fnpgt7mjjvut6qc80sqk
```

Preferred signing method:

```bash
SIGN_WITH=browser zsp publish zapstore.yaml
```

For CI, use NIP-46 bunker signing through a secret:

```bash
SIGN_WITH="bunker://pubkey?relay=wss://relay.example.com&secret=..." zsp publish -y zapstore.yaml
```

Avoid publishing with the raw `nsec` in shell history or a shared
environment. On first publish, expect `zsp` to ask for certificate
linking so Zapstore can associate the APK signing key with the Nostr
publisher identity.
