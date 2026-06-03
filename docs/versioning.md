# Versioning

Deepmarks has multiple release streams. They sometimes share a version
number for clarity, but they are not the same artifact.

| Stream | Where it appears | What it means |
|---|---|---|
| Public source release | GitHub tags/releases on `deepmarks-public`, for example `v0.6.5` | A sanitized source snapshot for audit, contributors, and public release notes. |
| Web/server deploy | Private `main` commit SHA deployed to Box A/B/C | The live website, API, relay, archive worker, and bunker. Deploys are tracked by commit, not by app-store version. |
| Android app | `frontend/android/app/build.gradle` `versionName` + `versionCode` | Play Console, Zapstore APK metadata, and installed Android app updates. `versionCode` must always increase. |
| iOS app | `frontend/ios/App/App.xcodeproj/project.pbxproj` `MARKETING_VERSION` + `CURRENT_PROJECT_VERSION` | App Store/TestFlight and installed iOS app updates. Build number must always increase. |
| Browser extensions | `browser-extension/package.json` and generated Chrome/Firefox manifests | Chrome Web Store and Firefox AMO package updates. Store manifest version must always increase. |
| Zapstore | `zapstore.yaml` + signed Android APK | A Nostr-published Android APK release. It uses the Android APK version and its own release notes file. |

## Current Policy

- Public GitHub source releases stay on the public 0.x series until we
  intentionally rename that stream.
- Installed app and extension packages can move faster because store
  resubmissions require monotonically increasing versions.
- Server deploys are identified by Git commit SHA. A server deploy alone
  does not update installed native apps or browser extensions.
- When a client-side fix affects mobile and extensions, bump Android,
  iOS, Zapstore, and browser-extension versions together so users can
  reason about which installed clients contain the fix.

## Examples

Private archive key fixes are client-bundle fixes. A complete release
requires:

- deploy the web/server commit
- rebuild and submit Android APK/AAB
- publish the Zapstore APK
- prepare a new iOS build
- package and submit browser extensions if extension code changed
- publish a public source release, using the next public source tag
  such as `v0.6.5`, with notes that mention the installed app/extension
  version line

Server-only fixes, such as queue worker retry behavior, can be deployed
by commit SHA and documented in the next public source release without
forcing native app or browser-extension resubmissions.
