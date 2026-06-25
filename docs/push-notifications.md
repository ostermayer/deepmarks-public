# Push notifications

How Web Push works in Deepmarks, who's actually delivering the
messages, and what's needed to extend it to the iOS Capacitor app.

## TL;DR

- We are **not** running a push server. We're a Web Push **sender**
  signing payloads with our VAPID key and POSTing them to the
  browser vendor's push service.
- The actual delivery infra is Firebase Cloud Messaging (Chrome),
  Mozilla Autopush (Firefox), or Apple Push Notification Service
  (Safari) — depending on which browser the subscriber is using.
- Web Push works in browsers (web + browser extension).
  **iOS Capacitor app does not receive Web Push** — that needs the
  native APNs path via `@capacitor/push-notifications`, which is
  Stage 3 work.

## The wire protocol

Web Push is an open standard:

- [RFC 8030](https://datatracker.ietf.org/doc/html/rfc8030) — Web
  Push Protocol (HTTP semantics for sending)
- [RFC 8292](https://datatracker.ietf.org/doc/html/rfc8292) —
  Voluntary Application Server Identification (VAPID): how a sender
  authenticates to a push service without an account

Browser vendors run interoperable HTTP endpoints implementing both
RFCs. We hold a single VAPID key pair and use it to push to any
vendor's endpoint; we have no relationship — no account, no
contract, no payment — with FCM, Mozilla, or Apple. They publish
the spec; we adhere to it.

## End-to-end flow

```
User opens deepmarks.org in Chrome and grants notification permission
        │
        ▼
  service-worker.js registers with Chrome's local push subsystem
        │
        ▼
  pushManager.subscribe(applicationServerKey: VAPID_PUBLIC_KEY)
        │
        ▼
  Chrome talks to fcm.googleapis.com; FCM mints a per-browser
  subscription endpoint URL + p256dh/auth key pair
        │
        ▼
  Browser hands deepmarks.org the PushSubscription object:
    { endpoint: "https://fcm.googleapis.com/wp/<opaque>", keys: {…} }
        │
        ▼
  /web-push/subscribe POST (NIP-98 auth) stores it in Redis
    dm:push:subs:<pubkey>  →  SET of subscription JSON
```

```
A different Nostr user zaps one of your bookmarks
        │
        ▼
  kind:9735 zap receipt lands on relay.deepmarks.org
        │
        ▼
  zap-listener (workers/zap-listener.ts) sees it, extracts
  recipient pubkey + sat amount + target event id
        │
        ▼
  sendPush(redis, recipientPubkey, payload) (web-push.ts):
    - reads dm:push:subs:<recipientPubkey>
    - signs payload with VAPID_PRIVATE_KEY
    - POSTs to each subscription endpoint
        │
        ▼
  fcm.googleapis.com / updates.push.services.mozilla.com / web.push.apple.com
  receive the POST, deliver to the user's browser via their own
  long-lived connection to that browser
        │
        ▼
  Browser dispatches `push` event to service-worker.js
        │
        ▼
  service-worker showNotification('N sats received', { ... })
```

## Browser → vendor mapping

| Browser | Push service | Endpoint host |
|---|---|---|
| Chrome / Chromium / Edge / Brave / Opera / Arc | Firebase Cloud Messaging | `fcm.googleapis.com` |
| Firefox / Firefox forks (Tor Browser, etc.) | Mozilla Autopush | `updates.push.services.mozilla.com` |
| Safari (macOS) | Apple Push Notification Service | `web.push.apple.com` |
| Safari (iOS) — installed PWA only, 16.4+ | Apple Push Notification Service | `web.push.apple.com` |
| Capacitor WKWebView (iOS) | **not supported** | — |
| Capacitor WebView (Android) | **maybe** — depends on Chromium System WebView version, usually FCM | `fcm.googleapis.com` |

## Cost + scaling

- **Free** at every realistic scale. FCM throttles around ~600
  messages/sec per subscription before backpressure; Mozilla
  Autopush is comparable; Apple Web Push is more conservative.
- **No vendor account required** for FCM and Mozilla — VAPID is the
  full auth story. Apple's web push is a little stricter and may
  require `VAPID_SUBJECT` to be an `https://` URL pointing at the
  pushing domain (rather than `mailto:`), in case Safari pushes
  start bouncing.
- **No quota application** needed.

## Privacy boundaries

The subscription endpoint URL is opaque from our side
(`https://fcm.googleapis.com/wp/<random>`); we cannot identify the
user from it. But the **vendor knows**:

- That deepmarks.org sent a push to this endpoint
- At what time
- The payload **size** (payload bytes are encrypted end-to-end with
  the subscription's `p256dh`/`auth` keys, so vendor can't read
  contents)

So the privacy story is: **Deepmarks the relay is Nostr-native and
sovereign; Deepmarks the notification layer is unavoidably FCM /
Mozilla / Apple.** There's no Nostr-native push alternative because
push permissions are gated by the OS/browser, which only trusts its
own vendor's push service.

A privacy-maximizing user can simply not subscribe — every other
feature still works. Push is opt-in via the toggle in `/app/settings`.

## VAPID key setup (one-time, operator)

1. Generate on any machine with Node 20+:
   ```bash
   npx --yes -p web-push web-push generate-vapid-keys
   ```
   Prints a public key (~88 char base64url) and a private key
   (~43 char base64url).

2. Save to `deploy/box-a/.env`:
   ```
   VAPID_PUBLIC_KEY=<the public half>
   VAPID_PRIVATE_KEY=<the private half>
   VAPID_SUBJECT=mailto:alerts@deepmarks.org
   ```
   The `.gitignore` rule `*vapid*` blocks committing any
   `vapid_*` file by accident.

3. Redeploy Box A:
   ```bash
   ./deploy/push-deploy.sh --only a
   ```

4. Verify:
   ```bash
   curl https://api.deepmarks.org/web-push/public-key
   ```
   Should return `{"publicKey":"B..."}` instead of 503.

### Rotation

Generate a new pair and overwrite both halves in `.env`. All
existing subscriptions become invalid on first push attempt — the
vendor returns 404/410, `sendPush` drops the stale subscription
from Redis, and the browser re-subscribes on next page load with
the new key. Net: a rotation takes one user action (visit the
site) per device to complete.

### Backup

The private key is a real secret. Treat it like the BTCPay invoice
macaroon or any nsec — back it up in a password manager / sealed
envelope. Losing it means rotation and a window of dropped pushes
while users re-subscribe.

## Stage 3 — iOS native push (not yet shipped)

The web service worker is registered inside the iOS Capacitor
WKWebView, but iOS doesn't dispatch `push` events to it when the
app is backgrounded or terminated. To get push notifications on
the iOS app:

1. Add `@capacitor/push-notifications` to `frontend/package.json`
2. Generate an Apple Push Notification certificate in the Apple
   Developer portal
3. Wire the iOS app to request push permission + register with
   APNs at first launch
4. Add a parallel path in `api` to send APNs pushes via
   a JWT-signed POST to `api.push.apple.com` — using the same
   `dm:push:subs:<pubkey>` storage pattern but with an
   `apnsToken` variant alongside the Web Push `endpoint` variant
5. zap-listener fans out to both Web Push subscriptions AND APNs
   tokens for each recipient

The frontend's `PushNotificationsSection` already detects
`isNativeShell()` and shows "go to iOS Settings → Deepmarks"
instead of the browser permission prompt. Wiring up the actual
APNs path is the missing piece.

Until that ships, iOS app users do not receive push notifications.
Web users on desktop / mobile browsers do.
