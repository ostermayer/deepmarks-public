# Deepmarks Android 1.10

This Android release finishes the mobile wallet and friends-feed polish from the 1.9 signer release:

- Adds QR scanning for Nostr Wallet Connect setup on mobile.
- Saves NWC wallet connections in native secure storage, including sessions signed in through Android signers such as Primal or Amber.
- Lets NWC zaps proceed when a provider returns a payable invoice that cannot produce a verifiable public NIP-57 receipt.
- Updates friends-feed zap totals immediately after a successful in-app payment while relay receipts remain the durable source of truth.
- Detects extensionless Blossom media URLs by HTTP content type so MP4 blobs from servers such as `blossom.primal.net` can show playable previews.
- Warms preview metadata earlier and lazy-loads preview images to reduce visible loading lag while scrolling the friends feed.

