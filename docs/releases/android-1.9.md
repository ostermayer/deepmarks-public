# Deepmarks Android 1.9

This Android release makes Deepmarks a more complete Nostr signer:

- Adds NIP-55 background signing for trusted apps so common requests can complete without repeated foreground bounces.
- Adds app-level signer permissions: full trust, medium trust, and low trust.
- Supports private zap signer requests, including `decrypt_zap_event`.
- Keeps signed-in users out of the public welcome/sign-up screen during Android signer handoffs.
- Improves friends-feed preview loading while scrolling.
- Centers and resizes the Android launcher pennant.
