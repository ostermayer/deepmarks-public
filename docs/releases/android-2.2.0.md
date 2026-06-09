# Deepmarks Android 2.2.0

Reliability release: every finding from the June 2026 sync/durability
review is fixed and locked in by a regression test suite (see
`tests/README.md` in the source repo).

- **Private bookmarks can no longer be erased by a bad sync.** Saving,
  editing, or deleting a private bookmark refuses to rewrite the
  encrypted set when any chunk failed to decrypt (sleepy remote signer,
  denied prompt, corrupt payload) instead of silently republishing the
  set without those entries.
- **Deletes finally propagate across devices.** Deleting a private
  bookmark on one device now removes it everywhere: other devices honor
  the delete tombstone instead of resurrecting the bookmark from their
  local cache on the next save.
- **Same-second edits render identically on every device.** Conflict
  tie-breaks now match what the relay itself retains (NIP-01 lowest
  event id), so two devices no longer show different versions of the
  same bookmark.
- **Offline edits are safer.** A queued edit can no longer be dropped
  when an older save of the same URL is acknowledged first.
- **Bookmarked Nostr posts appear once they're available.** A note whose
  event reaches the relay moments after you open the app now shows up
  without a restart.
- **Archives open even if the primary store hiccups.** Opening an
  archive falls back to its recorded Blossom mirrors (with content-hash
  verification) instead of failing when one server is down.
- Relay-side hardening: deterministic relay rejections are dead-lettered
  for operator review instead of being retried into silence, and bulk
  private deletes no longer trip the general rate limit.
