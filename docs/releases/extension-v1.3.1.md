# Extension v1.3.1

Historical browser-extension release record. The active public GitHub
source release stream is now the `v0.6.x` series; extension packages
keep their own monotonically increasing store manifest versions and are
submitted manually to Chrome Web Store and Mozilla AMO.

Deepmarks browser extension release 1.3.1 shipped source bundles for
Chrome, Firefox, and Safari under `browser-extension/` in this snapshot.

## What's new

- Approval popup is anchored over the focused browser window and clamped
  to onscreen coordinates so it can no longer land off the left edge on
  Firefox.
- Sign-out and the two delete confirms no longer rely on
  `window.confirm()`; they use an inline click-again-to-confirm pattern
  that works inside Safari Web Extension popups.
- Safari background now uses `background.scripts` instead of
  `background.service_worker`, avoiding intermittent Safari MV3
  service-worker registration failures.
- Safari NIP-07 approval flow surfaces a popup instead of silently
  queueing on the badge.
- Sign-in popup stays on the SignRequest screen after approval so the
  common back-to-back NIP-07 calls both land in the same popup session.

## Store status

- Chrome: manually submitted through Chrome Web Store.
- Firefox: manually submitted through Mozilla AMO.
- Safari: shipped through the Deepmarks macOS/iOS app path.
