# Deepmarks Android 2.0.1

This Android release promotes the Android app to the shared 2.0.1 app version:

- Provides Android Nostr signer support for foreground signer flows.
- Adds Android signer login support so users can sign in through installed signers such as Amber or Primal instead of pasting a recovery key.
- Adds mobile NWC QR scanning and secure on-device wallet storage.
- Improves the friends feed so it defaults to friends' saved bookmarks across `39701`, `10003`, and `30003`, with raw `kind:1` social-post links available as an opt-in gear setting.
- Adds zap-sats sorting and public-relay zap totals for bookmark feeds, friends bookmarks, saved posts, tags, and explore views.
- Improves friends-feed identity caching, preview loading, video thumbnails, zap-count updates, and refresh behavior.
- Saves friends-feed Nostr posts as full source notes in the Posts category.
- Updates mobile navigation parity with iOS, including bottom-tab search/posts/read-later/friends/bookmarks behavior.
