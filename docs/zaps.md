# Zaps

Bookmark zaps are direct Lightning payments to the bookmark curator when
the curator has a Lightning address. Deepmarks no longer takes a split
from bookmark zaps.

## Recipient Selection

When a user zaps a public bookmark:

1. Resolve the bookmark curator's Nostr profile.
2. Use the curator's `lud16` / `lud06` Lightning address when present.
3. Fall back to `zap@deepmarks.org` when the curator has no Lightning
   address.

The public Deepmarks social profile uses `dan@deepmarks.org`. The admin
operational identity uses `zap@deepmarks.org`.

## Payment Paths

If the user has NWC connected in the web app, the zap dialog can send
the invoice directly through NWC.

If no wallet is connected, the zap dialog shows a normal Lightning
invoice and QR code. The overlay closes after successful zap receipt
detection and shows the lightning success animation.

The browser extension can also hold an encrypted NWC connection and
expose WebLN to compatible sites.

## Receipts

Zap receipts are standard NIP-57 `kind:9735` events. For Deepmarks-hosted
addresses, `payment-proxy` verifies settlement and asks the Box C bunker
to sign the receipt. For outside curators, the curator's LNURL provider
is responsible for receipts.

Detailed money-flow and LNURL behavior lives in [lightning.md](lightning.md).
