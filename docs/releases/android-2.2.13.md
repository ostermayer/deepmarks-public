# Deepmarks Android 2.2.13

Security and reliability hardening from the 2026-08-23 full-codebase
review, plus the nsec sign-in fixes that shipped to web/extension after
2.2.12 was cut.

- **Logout fully logs out.** A session restore that was still in flight
  when you tapped Logout could resume afterward, silently re-mirroring
  the key into the iOS shared Keychain and signing the session back in.
  Logout now invalidates any in-flight restore.
- **Paired apps can't self-upgrade their permissions.** A NIP-46 app you
  approved for one capability could previously request more on any
  reconnect and have them granted silently. Requested-but-unapproved
  permissions are now ignored and surfaced in the signer status.
- **Your follow / friends / mute lists are protected.** A relay hiccup
  during a follow or mute could replace your whole list with a
  near-empty one. Mutations now refuse to publish unless the current
  list definitively loaded.
- **nsec sign-in hardening.** A mistyped nsec no longer echoes the
  pasted secret into the page; ALL-UPPERCASE (QR-scanned) nsecs are
  accepted; invalid keys get clear errors.
- **Smaller fixes:** read-later toggle failures now revert cleanly;
  profile-picture uploads verify the server stored exactly the bytes
  sent; zaps on bookmarks carry the addressable coordinate so receipts
  survive edits; importer edge cases (HTML entities, malformed Pinboard
  rows) and YouTube video-id casing corrected.
- **iOS parity:** `2.2.13` / build `43` to match the Android
  `2.2.13` / `versionCode 43` bump.
