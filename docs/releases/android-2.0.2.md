# Deepmarks Android 2.0.2

This Android release promotes the app to the shared 2.0.2 version:

- Improves the friends bookmark feed by hiding unresolved note targets
  until they are available from relay cache.
- Renders Nostr profile and post references as readable links instead of
  exposing raw `nostr:` strings.
- Uses the same cleaner metadata preview treatment as the bookmark tab.
- Improves retry behavior for bookmarked Nostr posts that arrive after a
  relay-cache miss.
- Benefits from server-side profile and bookmark warming for faster friend
  pickers and friends-feed loads.
- Prioritizes friends-feed cache refreshes when active users publish
  bookmark-shaped events.
- Keeps native WebViews out of service-worker caching and adds boot
  recovery if stale cache state ever leaves the app on the loading screen.
