# Deepmarks Android 2.2.9

Fixes for the launcher icon, an external-signer interruption, and YouTube
archiving.

- **App icon fixed.** The pennant in the round/adaptive launcher icon was
  oversized and off-center; it's now properly sized and centered within
  the icon circle.
- **No more interruptions from other signer apps.** If you open another
  Nostr app (for example Amethyst) that has Deepmarks selected as its
  external signer, Deepmarks no longer pops to the foreground asking you
  to sign in. Deepmarks now only acts as a signer for other apps when you
  have explicitly turned that feature on; otherwise it stays out of the
  way.
- **YouTube archives no longer capture the "not a bot" page.** When
  YouTube serves a "sign in to confirm you're not a bot" wall (or a
  consent/login redirect) instead of the real page, Deepmarks now records
  the archive as blocked rather than saving and showing that wall as your
  archive.
