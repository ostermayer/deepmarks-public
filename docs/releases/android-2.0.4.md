# Deepmarks Android 2.0.4

This Android release adds direct private bookmark publishing from the
native share sheet:

- Private/default-private shares publish immediately as encrypted
  NIP-44 private-item events when the local Deepmarks key is available.
- Public shares continue to publish as `kind:39701` from the share sheet.
- The host app still drains the App Group/native queue later for local
  state, archive queueing, and fallback saves, but it no longer needs to
  open before a successful native private share appears on web.
- Private deletes publish encrypted tombstones so standalone mobile share
  items do not reappear after removal.
