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

Once `/publish` accepts the event (a 202), server-side delivery takes
over: `/publish` only enqueues the signed event onto
`dm:publish-relay:queue`, and the relay-fanout worker (in the
`worker-relay-sync` container) both forwards it to strfry and fans it out
to the author's NIP-65 relays. That drain is crash-safe: the worker
`BLMOVE`s each event into a per-worker processing list and, on the next
boot, re-queues any list left behind by a worker that died mid-forward
(heartbeat-gated) — so a hard crash between the pop and the forward can't
lose a 202-acknowledged save. Transient forward failures retry on a
backoff and, if exhausted, land in a dead-letter list rather than
vanishing.

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
in settings runs `republishAllOwnBookmarks(pubkey, visibility)`
(`frontend/src/lib/nostr/republish-all.ts`). That function is
**additive**: each half first reads what the relay already has and
publishes only what is missing.

1. Reads the ownBookmarks store and splits by visibility.
2. For public: reads the relay's current `kind:39701` set, then builds
   one `kind:39701` template per *missing* public URL.
3. For private: reads the relay's current private set, then builds one
   encrypted per-item event per *missing* private URL.
4. Enqueues every resulting template via `enqueuePendingPublish`.
5. Returns immediately; the drainer signs and POSTs through
   `/publish` in the background.

It never rewrites the chunked set, never resurrects tombstoned URLs, and
skips entirely when the relay is unreachable, so a stale device cannot
re-assert old state.

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


## 2026-06 reliability updates

- **Re-stamp at drain**: replaceable (d-tag) templates get
  `created_at = max(now, original+1)` when drained (web re-stamps, the
  extension re-signs) — the relay used to silently discard offline
  edits as "older" after any newer save of the same key.
- **Attempt budget**: offline drains are skipped entirely and
  locked-signer failures don't increment attempts — a tab left open on
  a flight or passkey-locked no longer burns queued saves to expiry.
- **Exact-template removal**: success acknowledgements remove only the
  exact template, so an older save's ack can't delete a newer queued
  edit sharing its (kind, d-tag) dedupe key.
- **Visibility**: the reactive `pendingPublishes` store drives an
  "N saves waiting to sync" line on the bookmarks view.
- **Extension**: the queue drains from the background service worker on
  a 2-minute chrome alarm (locked/offline-guarded), not just while the
  popup is open; direct-mode publishes that miss the canonical relay
  queue a retry.

Guards: `tests/frontend/regression/offline-queue-safety.test.ts`,
`pending-publish-dedupe-race.test.ts`,
`tests/browser-extension/regression/edit-field-preservation.test.ts`.
