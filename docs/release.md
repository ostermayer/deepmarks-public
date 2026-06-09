# Public release checklist

Deepmarks has separate public source, server deploy, native app,
browser-extension, and Zapstore release streams. Read
[`versioning.md`](versioning.md) before cutting a release.

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

Before the export can be committed or pushed, the script runs a
fail-closed secret scan over the sanitized tree. It blocks known local
credential filenames, keystore-like artifacts, private-key blocks, live
payment/API key shapes, and real-looking `nsec1...` values. Only
checked-in dummy/test nsec strings are allowlisted.

By default, `scripts/publish-public.sh --tag-version` reads the release
version from `frontend/package.json`. Use `--version X.Y.Z` when the
public source-release cadence should differ from installed app/store
versions. This matters when native or extension builds move quickly for
store resubmissions but the public GitHub source release should remain on
the public 0.x patch series.

## Client-fix release gate

Some fixes are client-bundle fixes, not server-only deploys. Any change
under the archive open/save flow, private archive key sync, signer
storage, share drain, or browser extension archive flow must ship in all
installed clients that contain that code:

- bump `frontend/package.json` and `frontend/package-lock.json`
- bump Android `versionCode` and `versionName` in
  `frontend/android/app/build.gradle`
- bump iOS `CURRENT_PROJECT_VERSION` and `MARKETING_VERSION` in
  `frontend/ios/App/App.xcodeproj/project.pbxproj`
- bump `browser-extension/package.json` and
  `browser-extension/package-lock.json` when extension code changed
- update `zapstore.yaml` release notes to a release file that mentions
  the client fix
- rebuild and resubmit the Android APK/AAB, Zapstore APK, iOS build, and
  extension zip packages as applicable

Do not mark a private archive/key fix as fully released just because the
web app or servers were deployed. Previously submitted native or
extension packages are stale if they were built before the fixing commit.

## Historical 0.6.0 public release scope

The 0.6.0 GitHub public release was for the web app, server services,
documentation, and browser-extension source/packages. It documented the
server-mediated publish model: clients sign locally, POST signed events
to the API, and Deepmarks fans out from `relay.deepmarks.org` to the
user's relay list.

The iOS and Android Capacitor projects remained in the public source tree
for audit and contributor work, but mobile app binaries were not release
artifacts for that GitHub tag. Current mobile build/submission guidance
lives in [`mobile.md`](mobile.md).

Dry run first:

```bash
./scripts/publish-public.sh --dry-run --keep-export --tag-version --version 0.6.5 -m "Prepare Deepmarks public release"
```

Inspect the printed export path:

```bash
rg -n -I 'nsec1|BEGIN (RSA|OPENSSH|PRIVATE)|172\.(238|237|234)\.' <export-path>
git -C <export-path> ls-files | rg '(^|/)(publicprofile-nsec|deepmarks-admin-nsec|.*macaroon|.*secret|.*\\.jks|.*\\.keystore|.*\\.p12)'
git -C <export-path> ls-files | rg 'frontend/android|frontend/ios|zapstore.yaml|LICENSE'
```

The scripted secret scan must pass even if the manual `rg` checks find
only allowed dummy fixtures.

Only after review, push the public mirror:

```bash
./scripts/publish-public.sh --tag-version --version 0.6.5 -m "Prepare Deepmarks public release"
```

That force-pushes `main` on `ostermayer/deepmarks-public`; do not run
it until the exported tree has been inspected.

The script has a `--github-release` shortcut, but it writes generic
notes. For public releases with real user-facing notes, push the mirror
and tag first, then create the Release object from the checked-in notes
file:

```bash
gh release create v0.6.5 \
  --repo ostermayer/deepmarks-public \
  --title "Deepmarks v0.6.5" \
  --notes-file docs/releases/v0.6.5.md
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

If you need a quick generic Release for an internal milestone, the
shortcut is:

```bash
./scripts/publish-public.sh --tag-version --github-release -m "Prepare Deepmarks public release"
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
- `scripts/zapstore-publish.sh`
- `screenshots/android/phone/`

The Zapstore publisher identity is:

```text
npub199zwj9d6w88slsvlthdqfr8q2w58cq0aw3utz7fnpgt7mjjvut6qc80sqk
```

The local publisher nsec lives at `publicprofile-nsec.txt`, which is
ignored and must not be committed. The helper reads it without putting
the key in shell history:

```bash
./scripts/zapstore-publish.sh check
./scripts/zapstore-publish.sh publish
```

For CI or other unattended publishing, use NIP-46 bunker signing through
a secret instead of a raw nsec:

```bash
SIGN_WITH="bunker://pubkey?relay=wss://relay.example.com&secret=..." zsp publish -y zapstore.yaml
```

On first publish, expect `zsp` to ask for certificate linking so
Zapstore can associate the APK signing key with the Nostr publisher
identity.

## Browser extension packages (Chrome + Firefox)

Chrome and Firefox store submission is manual. A release produces two
review-ready zip files; the operator uploads those zips in the Chrome Web
Store and Mozilla AMO dashboards.

A version-tagged push triggers a GitHub Actions workflow
(`.github/workflows/publish-browser-extension.yml`) that typechecks,
tests, packages the extension, verifies manifest versions, and uploads
the zips as workflow artifacts. It does not submit to either store.

### Cutting a release package

```bash
cd browser-extension
npm version 1.1.8                  # bumps package.json + auto-commits
git tag extension-v1.1.8           # match the tag prefix the workflow watches
git push origin main --tags
```

The workflow listens on the `extension-v*` tag pattern; pushing just
the tag re-runs the package workflow for the version already on HEAD.
There is also a `workflow_dispatch` trigger so packages can be rebuilt
manually from the Actions tab.

Local packaging remains the fastest path when preparing a release from a
trusted workstation:

```bash
cd browser-extension
npm run package:stores
```

Prepared files:

- `browser-extension/chrome/deepmarks-chrome.zip`
- `browser-extension/firefox/deepmarks-firefox.zip`

### What the workflow does

- **Builds review-ready zips only.** Chrome Web Store and AMO upload is
  manual.
- **Does not bump the version itself.** You bump locally via
  `npm version`; the workflow only packages whatever is on the tag.
- **Does not republish Safari.** The Safari extension build
  (`npm run build:safari-app`) goes through Xcode and the App
  Store; no API to automate against. Keep doing that one by hand.
