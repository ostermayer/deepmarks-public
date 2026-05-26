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
`v0.6.0` corresponds to the version visible on the website.

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

The script has a `--github-release` shortcut, but it writes generic
notes. For public releases with real user-facing notes, push the mirror
and tag first, then create the Release object from the checked-in notes
file:

```bash
gh release create v0.6.0 \
  --repo ostermayer/deepmarks-public \
  --title "Deepmarks v0.6.0" \
  --notes-file docs/releases/v0.6.0.md
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

## Browser extension auto-publish (Chrome + Firefox)

A version-tagged push triggers a GitHub Actions workflow
(`.github/workflows/publish-browser-extension.yml`) that builds,
typechecks, lints, tests, and publishes the extension to both
Chrome Web Store and Mozilla AMO.

### Cutting a release

```bash
cd browser-extension
npm version 1.1.8                  # bumps package.json + auto-commits
git tag extension-v1.1.8           # match the tag prefix the workflow watches
git push origin main --tags
```

The workflow listens on the `extension-v*` tag pattern; pushing just
the tag (without code) re-runs the publish for the version already on
HEAD. There's also a `workflow_dispatch` trigger so you can re-run
publishes manually for one target via the Actions tab.

### One-time secret setup

Add these in **Settings → Secrets and variables → Actions** on the
GitHub repo where the workflow lives.

**Chrome Web Store** — uses the Publish API ([docs](https://developer.chrome.com/docs/webstore/using-the-api)):

| Secret | Where to get it |
|---|---|
| `CHROME_EXTENSION_ID` | The Item ID in the Web Store dashboard URL (`/detail/<id>`) |
| `CHROME_CLIENT_ID` | Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID (Desktop app) |
| `CHROME_CLIENT_SECRET` | Same OAuth 2.0 Client |
| `CHROME_REFRESH_TOKEN` | One-time OAuth dance (see Google's docs); the refresh token never expires unless revoked |

**Mozilla AMO** — uses the Add-on Submission API v5 ([docs](https://addons-server.readthedocs.io/en/latest/topics/api/addons.html#submit-version)):

| Secret | Where to get it |
|---|---|
| `AMO_JWT_ISSUER` | addons.mozilla.org → Developer Hub → "Manage API Keys" → "JWT issuer" |
| `AMO_JWT_SECRET` | Same page → "JWT secret" |
| `AMO_ADDON_SLUG` | The slug in the AMO listing URL (e.g. `deepmarks`) |

### Running locally

The publish scripts work from a local machine too — useful for a
first-time publish before CI is set up or for debugging:

```bash
cd browser-extension
export CHROME_EXTENSION_ID=…
export CHROME_CLIENT_ID=…
export CHROME_CLIENT_SECRET=…
export CHROME_REFRESH_TOKEN=…
npm run publish:chrome

# OR

export AMO_JWT_ISSUER=…
export AMO_JWT_SECRET=…
export AMO_ADDON_SLUG=deepmarks
npm run publish:firefox

# OR both at once
npm run publish:both
```

### What the workflow does NOT do

- **Does not bump the version itself.** You bump locally via
  `npm version`; the workflow only publishes whatever's on the tag.
- **Does not republish Safari.** The Safari extension build
  (`npm run build:safari-app`) goes through Xcode and the App
  Store; no API to automate against. Keep doing that one by hand.
- **Does not roll back on a partial failure.** If Chrome succeeds
  but AMO fails (or vice versa), inspect the workflow log, fix the
  AMO listing, and re-run via `workflow_dispatch` with
  `target=firefox`.
