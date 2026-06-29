# Deepmarks Android 2.2.1

Round two of the June 2026 reliability work, on top of 2.2.0 (which has
not shipped to stores — 2.2.1 supersedes it and carries both rounds).

- **Remote signers can't freeze the app.** If your NIP-46 bunker or
  Amber phone is asleep, private-bookmark decryption now times out and
  tells you, instead of silently hanging the private list forever.
- **Decryption problems are explained.** When part of your private set
  can't be decrypted, the bookmarks page shows what happened — signer
  not responding, signer without nip-44 support, or corrupt data — with
  a retry button, instead of a silently smaller list. Read-only
  sessions get a "unlock your signer to view private bookmarks" hint.
- **Bookmarked Nostr posts stop disappearing.** A post whose event
  isn't reachable shows a placeholder with a link to open it on primal
  (your bookmark stays saved) instead of rendering nothing, and pasting
  a `note1…` / `nevent1…` / `nostr:` reference into the save box now
  saves the note instead of failing with "Invalid URL".
- **Big imports stop losing bookmarks.** Bookmark writes get their own
  relay budget (1000/hour instead of the shared 200/hour bucket),
  rejected events no longer count against the budget, and rate-limited
  events are retried for hours instead of being dropped — so a
  multi-thousand-bookmark import fully lands on the relay.
- Includes everything from 2.2.0: private-set wipe protection,
  cross-device delete propagation, NIP-01-consistent conflict
  resolution, safer offline edits, archive mirror fallback, and
  relay-side dead-lettering.
