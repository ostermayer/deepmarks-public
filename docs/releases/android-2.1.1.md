# Deepmarks Android 2.1.1

Hotfix on top of 2.1.0.

- **Privacy fix:** tagging, read-later, or archiving an imported
  *private* NIP-51 bookmark (a Nostr-URL bookmark whose privacy lives in
  its list `visibility`, not a `private:` marker) could republish it as a
  public `kind:39701`. Such bookmarks now correctly stay private —
  preserve-origin is enforced for imported bookmarks in both the posts
  view and the main bookmark list. The "private/public" chip also labels
  imported private bookmarks correctly.
- Editing a not-yet-saved Nostr post no longer exposes delete /
  visibility-swap actions (there's no published event to act on); the
  first tag simply adopts the post.
- Friends' legacy `kind:30001` bookmark sets are now mirrored to
  relay.deepmarks.org so they render in the friends feed (the importer
  already understood them).
