# Deepmarks Android 2.2.3

Structural release: the four long-running reliability projects land
(no earlier 2.2.x shipped to stores — 2.2.3 supersedes them all and
carries every fix since 2.1.1).

- **Private bookmarks are now conflict-free.** Saving, editing, or
  deleting a private bookmark writes one small encrypted record for
  that bookmark alone, instead of re-encrypting and republishing your
  entire private library. Two devices editing at the same time can no
  longer overwrite each other's changes, and the failure modes that
  could erase a private library are structurally gone.
- **Large media archives finally play on iOS.** Media archives use a
  new chunked encryption format the app decrypts piece-by-piece with
  bounded memory — a 1 GB+ video plays instead of crashing the app.
  Old archives keep working; uploads of big files no longer time out
  and retry-download endlessly.
- **The relay now has a live second copy.** Every bookmark event is
  replicated to a standby within seconds, so a server disk failure can
  no longer lose up to a day of saves.
- Shared, drift-proof sync core: the bookmark-merging logic is now one
  audited implementation across web and the browser extension, locked
  together by the test suite.
