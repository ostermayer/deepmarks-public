# Deepmarks Android 2.2.5

Playback and polish release (no earlier 2.2.x shipped to stores —
2.2.5 supersedes them all).

- **Archived videos start playing immediately.** Newly archived media
  streams as it decrypts instead of downloading the whole file first —
  tap play, watch right away. Older archives keep the
  download-then-play behavior.
- **Exports are complete.** "Export my bookmarks" now includes
  bookmarks imported from other Nostr clients, including bookmarked
  posts.
- **Every device picks the same winner.** When the same bookmark was
  edited on two devices at once, web, app, and extension now resolve
  the conflict identically (matching what the relay itself keeps).
