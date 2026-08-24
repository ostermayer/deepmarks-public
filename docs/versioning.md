# Versioning

Deepmarks has multiple release streams. They sometimes share a version
number for clarity, but they are not the same artifact.

| Stream | Where it appears | What it means |
|---|---|---|
| Public source release | GitHub tags/releases on `deepmarks-public`, for example `v1.0.0` | A sanitized source snapshot for audit, contributors, and public release notes. |
| Web/server deploy | Private `main` commit SHA deployed to Box A/B/C | The live website, API, relay, archive worker, and bunker. Deploys are tracked by commit, not by app-store version. |
| Android app | `frontend/android/app/build.gradle` `versionName` + `versionCode` | Play Console, Zapstore APK metadata, and installed Android app updates. `versionCode` must always increase. |
| iOS app | `frontend/ios/App/App.xcodeproj/project.pbxproj` `MARKETING_VERSION` + `CURRENT_PROJECT_VERSION` | App Store/TestFlight and installed iOS app updates. Build number must always increase. |
| Browser extensions | `browser-extension/package.json` and generated Chrome/Firefox manifests | Chrome Web Store and Firefox AMO package updates. Store manifest version must always increase. |
| Zapstore | `zapstore.yaml` + signed Android APK | A Nostr-published Android APK release. It uses the Android APK version and its own release notes file. |

## Public GitHub Releases

The public GitHub repository is a sanitized source mirror. It reached its
`v1.0.0` stable milestone (graduating from the earlier `v0.x` line);
new public source releases continue as the `v1.x` series.

Older public releases named like `v2.0.x` or `extension-v...` are
historical client-aligned release records from before the release
streams were split clearly. They are retained for audit/history, but
they are not the current public source-release sequence.

When preparing a public GitHub Release today:

- use the next `v1.x` public source tag (e.g. `v1.0.x`)
- explain which installed app/extension version line contains the
  matching client fix
- do not tag the public source mirror with the mobile/extension store
  version unless we intentionally rename the public source stream

## Current Policy

- Public GitHub source releases continue on the public v1.x series (the
  stream graduated from 0.x at the v1.0.0 milestone).
- Installed app and extension packages can move faster because store
  resubmissions require monotonically increasing versions.
- Server deploys are identified by Git commit SHA. A server deploy alone
  does not update installed native apps or browser extensions.
- When a client-side fix affects mobile and extensions, bump Android,
  iOS, Zapstore, and browser-extension versions together so users can
  reason about which installed clients contain the fix.
- Chrome and Firefox extension submissions are manual. The repository
  builds and verifies the zips; the operator uploads them to the store
  dashboards.

## Examples

Private archive key fixes are client-bundle fixes. A complete release
requires:

- deploy the web/server commit
- rebuild and submit Android APK/AAB
- publish the Zapstore APK
- prepare a new iOS build
- package and submit browser extensions if extension code changed
- publish a public source release, using the next public source tag
  such as `v1.0.0`, with notes that mention the installed app/extension
  version line

Server-only fixes, such as queue worker retry behavior, can be deployed
by commit SHA and documented in the next public source release without
forcing native app or browser-extension resubmissions.
