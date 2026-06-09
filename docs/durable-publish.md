# Durable Publish Queue

Deepmarks must not lose user saves. A bookmark in your library that
never reached the server publish boundary is the same as a bookmark
that didn't happen — except worse, because the UI says it did. The
durable publish queue exists to retry failed client-to-API publishes
until the signed event reaches `/publish`.

## Why

`publishEvent()` (`frontend/src/lib/nostr/publish.ts`) signs locally,
then POSTs the signed event to `api.deepmarks.org/publish`. The API
returns once the server has accepted the event for forwarding to
`relay.deepmarks.org`; the user's device no longer waits on relay
WebSocket acks.

On iOS foreground transitions, flaky LTE, captive networks, or API
outages, that POST can still fail before the server accepts the event.
The queue persists the event template locally and re-runs
`publishEvent()` later with the user's signer.

Once `/publish` accepts the event, server-side retry takes over:
payment-proxy forwards to strfry and the relay-fanout worker retries
third-party relay fanout separately.

## What gets queued

`publishEvent()` enqueues an unsigned event template into the queue
when the local signing or `/publish` POST fails. Typical causes:

- signer unavailable or rejected the sign request
- network failure, timeout, or aborted iOS foreground request
- non-2xx response from `/publish`

The queue stores templates, not nsecs. Draining requires the signer to
be available again, then it signs a fresh event and POSTs it through
the normal path.

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
5. Returns immediately; the drainer signs and POSTs through
   `/publish` in the background.

A user can close the app after clicking re-sync. The 90 s timer +
foreground hook keep grinding through the queue across sessions.

## Caveats

- `publishEvent` is what enqueues on client-side failure, so any save
  path that doesn't go through publishEvent must provide its own retry or
  fallback. The iOS and Android native share sheets do this by queuing
  the edited payload for the host app whenever direct `/publish` cannot
  be completed from the share sheet.
- The queue is per-pubkey but per-device. localStorage isn't synced
  to the server. A pending save on Device A only retries from Device
  A; Device B's drainer won't see it. This is acceptable because
  successful publishes propagate through the server and relays
  regardless of origin device.
- NIP-46 bunker signers can be slow (each sign is a relay
  round-trip). Drain concurrency is intentionally low (4) so we
  don't queue 4000 sign requests at the signer in one burst.
