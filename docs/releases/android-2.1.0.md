# Deepmarks Android 2.1.0

This release restores private bookmark visibility, imports legacy
bookmark sets, and brings full bookmark actions to saved Nostr posts.

- Private NIP-51 bookmark lists now decrypt and show up. Users whose
  web bookmarks lived only in an encrypted `kind:10003`/`kind:30003`
  list (the default for Amethyst / Primal / Damus "private bookmarks")
  no longer see an empty library — the lists are decrypted on-device
  after sign-in. A late-attaching passkey/bunker signer re-runs the
  decrypt pass automatically.
- Legacy `kind:30001` bookmark sets are imported. Older clients
  (2023–2024 Amethyst / Nostrudel) wrote bookmark sets under the
  deprecated `kind:30001`; those are now mirrored and rendered like
  `kind:30003`, so a user whose only set is a legacy one no longer sees
  nothing.
- Saved Nostr posts get the same actions as web URL bookmarks: view /
  add / edit tags, read later, archive + download archive, zap, and
  share. The note content stays read-only — only your own tags and
  metadata are editable. Tagging or archiving an imported post adopts it
  as a Deepmarks bookmark, preserving its origin visibility (a privately
  bookmarked post stays private).
