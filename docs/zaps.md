# Zaps

Bookmark zaps are direct Lightning payments to the bookmark curator when
the curator has a Lightning address. Deepmarks no longer takes a split
from bookmark zaps.

## Recipient Selection

When a user zaps a public bookmark:

1. Resolve the bookmark curator's Nostr profile.
2. Use the curator's `lud16`, `lightning_address`, or `lud06` Lightning
   address/LNURL when present.
3. Fall back to `zap@deepmarks.org` when the curator has no Lightning
   address.

Zaps are attached to the specific bookmark event row. If Alice and Bob
save the same URL, Alice's row zaps Alice and Bob's row zaps Bob. The
public URL page (`/app/url/<url>`) is the place to see every curator who
saved the same link. Aggregated popular views may rank by URL, but the
visible row still has one curator; the zap button pays that curator.

The public Deepmarks social profile uses `dan@deepmarks.org`. The admin
operational identity uses `zap@deepmarks.org`.

## Payment Paths

If the user has NWC connected on the current Deepmarks client, the zap
dialog can send the invoice directly through NWC. The wallet credential
stays encrypted and local to that browser, extension profile, or mobile
app install; users connect NWC separately on each client where they want
one-tap zaps.

Native app builds use the Deepmarks API as a narrow LNURL fetch proxy
for invoice creation. The app still signs the NIP-57 zap request locally
and still pays through the user's local NWC connection; the API only
fetches public LNURL metadata/callback JSON and returns the BOLT-11
invoice. This avoids iOS/Android WebView CORS/ATS failures without
sending nsecs, NWC wallet secrets, or payment preimages to the server.

If no wallet is connected, the zap dialog shows a normal Lightning
invoice and QR code. The overlay closes after successful zap receipt
detection and shows the lightning success animation.

The browser extension can also expose WebLN to compatible sites.

## Receipts

Zap receipts are standard NIP-57 `kind:9735` events. For Deepmarks-hosted
addresses, `payment-proxy` verifies settlement and asks the Box C bunker
to sign the receipt. For outside curators, the curator's LNURL provider
is responsible for receipts.

The frontend verifies BOLT-11 `description_hash` values against the
signed zap request before payment. It hashes the exact JSON sent to the
LNURL callback, and also accepts common provider-side canonical key
orders for the same signed event. If an outside LNURL provider advertises
zap support but returns a regular invoice that is not bound to the zap
request, Deepmarks still permits the payment after amount validation, but
marks the invoice as not receipt-verifiable and does not wait forever for
a zap receipt.

Detailed money-flow and LNURL behavior lives in [lightning.md](lightning.md).
