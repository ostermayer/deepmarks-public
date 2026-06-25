# Deepmarks Android 2.2.4

Quality-of-life follow-up to the 2.2.3 structural release (no earlier
2.2.x shipped to stores — 2.2.4 supersedes them all).

- **Share a Nostr post straight into Deepmarks.** Sharing a
  `nostr:`/`note1…`/`nevent1…` reference from Damus, Amethyst, Primal,
  or any Nostr client now saves the post — no web URL needed.
- **Bookmarked posts show up everywhere.** Notes bookmarked in other
  Nostr clients now appear in your main bookmarks list and its search,
  not just the posts tab, and post lookups use the relay hints your
  lists carry, so they resolve faster.
- **Safer re-sync.** The "push to relay" recovery tool now checks what
  the relay already has and publishes only what's missing — it can no
  longer re-assert an old device's stale state or resurrect deleted
  bookmarks.
- **Less wasted work.** Media archives that failed permanently (deleted
  videos) are remembered and skipped instead of retried endlessly.
