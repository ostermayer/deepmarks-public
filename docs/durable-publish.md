# Durable Publish Queue

Deepmarks must not lose user saves. A bookmark in your library that
never reached the relay is the same as a bookmark that didn't happen
— except worse, because the UI says it did. The durable publish queue
exists to make sure every save eventually lands on
`relay.deepmarks.org`.

## Why

`publishEvent()` (`frontend/src/lib/nostr/publish.ts`) waits up to
4.5 s on web / 12 s on native for at least one relay in the user's
set to acknowledge the event. On a cold WKWebView WebSocket, on flaky
LTE, or when the user's NIP-65 set includes slow relays, that timeout
fires before any ack arrives. The previous behavior was to surface a
"relay sync pending" warning and move on, which left the user staring
at a bookmark that nobody but their browser knew about.

`relay.deepmarks.org` is the canonical store for Deepmarks-managed
data. Treating its specific ack as the success signal — not "any
relay" — is what makes cross-client sync work, because the web app
reads from there.

## What gets queued

`publishEvent()` enqueues a signed template into the queue when:

- the publish threw a non-recoverable error (signer failure, network
  blowup, no `publishedToRelays` set on the rejection), or
- zero relays acked within the timeout, or
- at least one relay acked but `relay.deepmarks.org` specifically
  did **not** ack.

In the third case the caller still receives a successful
`PublishResult` (some relay has the event); we just enqueue a
background retry so the canonical relay catches up.

## Storage

The queue is in `localStorage` under
`deepmarks-pending-publish:<pubkey>`, one key per signed-in pubkey so
account switches don't cross-pollinate. Each entry holds:

```ts
{
  pubkey: string;
  template: UnsignedEventTemplate;
  key: string;            // kind+d-tag for replaceable events, kind+content fingerprint otherwise
  enqueuedAt: number;     // ms epoch
  attempts: number;
  lastError?: string;
}
```

Re-enqueuing the same logical event (same `key`) updates the existing
row in place rather than appending — important for replaceable events
where only the latest is meaningful.

## Drain

`drainPendingPublishes(pubkey)` runs up to 4 publishes concurrently
(`DRAIN_CONCURRENCY = 4`). Successes drop from the queue;
failures stay with `attempts++`. Items age out at:

- `MAX_ATTEMPTS = 30` per item, or
- `EXPIRE_MS = 30 days` since enqueue,

whichever comes first.

The drainer is triggered from four places:

1. **`canSign` subscribe** in `own-bookmarks.ts` — the moment the
   user's signer becomes available (e.g. after a passkey unlock),
   we drain so events that were waiting for a signer go out.
2. **`refreshOwnBookmarks()`** in `own-bookmarks.ts` — fires on
   foreground via `appStateChange` (native) or
   `document.visibilitychange` (web), so coming back to the app
   pushes through anything queued while it was paused.
3. **Periodic timer** in `frontend/src/routes/+layout.svelte` —
   90 s tick while the app is open. Lets a re-sync that staged
   thousands of events make steady progress without user attention.
4. **Re-sync button** in settings — explicitly drains after
   enqueuing the full local cache.

## Recovery flow ("re-sync")

When a user's local cache has more bookmarks than the relay does
(typical aftermath of a partially-failed import), the re-sync button
in settings runs `republishAllOwnBookmarks(pubkey, visibility)`. That
function:

1. Reads ownBookmarks store, splits by visibility.
2. For public: builds a `kind:39701` template per bookmark.
3. For private: streams the full set through
   `buildPrivateSetReplacementEventStream` — same chunking the
   regular save uses.
4. Enqueues every resulting template via `enqueuePendingPublish`.
5. Returns immediately; the drainer takes over.

A user can close the app after clicking re-sync. The 90 s timer +
foreground hook keep grinding through the queue across sessions.

## Caveats

- `publishEvent` is what enqueues on failure, so any save path that
  doesn't go through publishEvent (none in current code; flagged
  here for future-proofing) would silently drop on the floor.
- The queue is per-pubkey but per-device. localStorage isn't synced
  to the server. A pending save on Device A only retries from Device
  A; Device B's drainer won't see it. This is acceptable because
  successful publishes propagate through the relay regardless of
  origin device.
- NIP-46 bunker signers can be slow (each sign is a relay
  round-trip). Drain concurrency is intentionally low (4) so we
  don't queue 4000 sign requests at the signer in one burst.
