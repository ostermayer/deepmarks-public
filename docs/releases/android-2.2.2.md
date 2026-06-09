# Deepmarks Android 2.2.2

Rounds three and four of the June 2026 reliability work, on top of
2.2.1 (no earlier 2.2.x shipped to stores — 2.2.2 supersedes them and
carries everything).

- **Deleting a bookmark finally deletes it everywhere.** Public deletes
  made on one device now propagate to your other devices instead of
  the bookmark quietly reappearing from a stale cache, and a deleted
  bookmark can no longer resurrect when its old copy arrives from a
  slow relay.
- **Offline saves are safer.** Edits queued while offline are
  re-stamped when they finally send (so the relay doesn't discard them
  as outdated), offline retries no longer burn the retry budget, and
  the bookmarks page shows "N saves waiting to sync".
- **Private and media archives can't lose their keys anymore.** The app
  refuses to queue an encrypted archive if your signer can't publish
  the key (with a clear explanation), retries unpublished keys
  automatically, keeps unpublished keys for 90 days instead of
  deleting them after 14, shows archives whose key is unrecoverable on
  this device instead of hiding them, and re-archives them — including
  media — with a fresh key.
- **The archive service heals itself.** Archives that completed but
  never appeared in your list are now re-delivered automatically;
  failed public page archives attempt a Wayback rescue; lost encrypted
  jobs are marked failed so the app can retry them, instead of leaving
  you waiting forever.
- Server-side: operator alerting for undeliverable saves, a relay
  write-health probe, and database-capacity monitoring.
