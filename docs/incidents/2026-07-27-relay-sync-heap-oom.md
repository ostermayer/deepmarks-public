# 2026-07-27 — relay-sync worker heap OOM crash-loop (nostr-tools sliced-string pinning)

> Severity: medium. Written 2026-07-27.

## Symptom

Restart probe alert at 2026-07-27T21:00:01Z:

> Container box-a-worker-relay-sync-1 on deepmarks-a has RestartCount=4
> and last started 502s ago.

Container logs end each life with:

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
[1:0x7effb77b4000] 949854699 ms: Mark-Compact (reduce) 2047.3 (2086.7) -> 2046.8 (2085.2) MB
```

The worker had in fact been crash-looping for three weeks: `worker group
started` lines show restarts on Jul 5 19:40, Jul 9 22:59, Jul 13 03:46,
Jul 16 21:00, and Jul 27 20:51 (all UTC) — heap OOM at the ~2GB V8
default cap every 3.5–4 days, stretching to 11 days after the Jul 17
duplicate-flood fix cut relay traffic. Only the Jul 27 crash alerted:
the earlier ones fell before the Jul 17 monitoring overhaul
(`2026-07-17-silent-monitoring.md`), and the restart probe only fires on
a recent restart.

## Impact

- Every 3.5–11 days the worker stalled in GC death-throes for a few
  minutes, then crashed and restarted. Publish-relay forwards were
  protected by the BLMOVE processing-list recovery (the Jul 27 boot
  recovered 1 orphaned event); nothing on that path was lost.
- Permanent small gaps in NIP-65 fanout: relay-fanout subscribes with
  `since = boot time`, so user events that reached strfry in the
  minutes around each crash were never fanned out to the authors'
  external relays. Our own relay was unaffected, so nothing is missing
  in-app.
- Onboarding scans mid-flight at crash time had already claimed their
  30-day `dm:onboarding:done:` marker; active users re-trigger via the
  hourly auth refresh, dormant ones wait out the marker.

## Root cause

`SimplePool.subscribeMany` (nostr-tools 2.23.3) keeps a per-subscription
`_knownIds` Set for cross-relay dedup and adds the id of **every event
the subscription ever receives**. The id it stores comes from
`getHex64(json, "id")`, which extracts the 64-char id from the raw
incoming frame with `String.prototype.slice` **before** JSON.parse — a
V8 *sliced string* that internally references the full parent frame.
Storing the slice pins the entire raw frame (`["EVENT","sub:1",{...}]`)
for the life of the subscription.

Three relay-sync workers hold process-lifetime `subscribeMany`
subscriptions to our own strfry:

- relay-fanout: kinds 0/1/3/5/10000/10002/10003/30000/30003/39701
- follows-ingester: kinds 3/30000 (no `since` — replays the full
  contact-list history on every boot)
- profile-resolver: kinds 39701 and 0

kind:3 contact-list frames run 100–250KB, and the follows-ingester
cycle keeps fresh kind:3/kind:0 events flowing, so pinned frames
accumulated at roughly 200MB per few hours right after boot (history
replay) and ~8MB/h steady state — to the 2GB heap cap in days. Heap
snapshot of the live process 3.2h after boot: 240MB total, 207MB string
data, **165.3MB of it raw relay frames retained solely as
sliced-string parents**. Sibling worker containers on the same image
(payments, enrichment, search-indexer) sat at ~50MB after 3 weeks —
they have no high-volume lifetime subscription.

Contributing: the pre-Jul-17 duplicate flood tripled relay traffic,
which is why crashes came every 3.5 days back then; the flood fix
stretched the fuse to 11 days without touching the leak.

## Timeline

- 2026-07-05 → 2026-07-16 — four unalerted heap-OOM restarts (cron
  alerting silent until Jul 17; no restart since Jul 17 until now).
- 2026-07-27 20:47–20:51 UTC — fifth OOM after 11 days up;
  RestartCount=4; restart probe alerts at 21:00.
- 2026-07-27 — diagnosis on the live process: `kill -USR1 1` to open
  the inspector, heap snapshot over the CDP WebSocket, retainer-graph
  analysis pinned 165MB on sliced-string parents referenced from
  `subscribeMany`'s `_knownIds`.
- 2026-07-27 — fix committed (`84681fe`) and deployed to Box A
  (`deploy.sh a worker-relay-sync`, container up 23:50:57 UTC).

## Fixes

`84681fe` — new `subscribeSingleRelay` helper in
`api/src/relay-helpers.ts`: `pool.ensureRelay(url)` +
`relay.subscribe(filters, params)`. Single-relay subscriptions have
nothing to dedup, so the leaking `_knownIds` layer is skipped entirely
and the id slice stays transient. relay-fanout, follows-ingester, and
profile-resolver switched over. Two behavior upsides came free:

- the helper retries the initial connect (subscribeMany silently gave
  up after one failed attempt, leaving a worker blind if it booted
  before strfry);
- nostr-tools' relay-level reconnect re-fires open subscriptions with
  `since = last-emitted + 1` after a strfry restart, where the old
  subscribeMany subscription just died silently.

Verified on Box A ~20 minutes after deploy, with the boot replay done
(506 contact lists seen, 4,621 events forwarded, 0 forward failures,
fanout/onboarding active): a fresh heap snapshot shows 9.8MB of string
data and **zero retained relay frames** — the ≥64KB string bucket
holds 14 strings totaling 1.4MB, all module source text. The same
bucket on the leaking build held 2,259 strings totaling 166.7MB, all
raw `["EVENT",...]` frames, after 3.2h.

Deliberately **not** switched: zap-listener and save-count-tracker.
Same bug class but tiny frames and no measurable growth after 3 weeks —
and zap-listener's `HINCRBY` aggregation is not idempotent under the
same-second replay a relay-level reconnect can produce. Switch them
only with an event-id dedup guard in front of the counter.

## Detection gap

The restart probe works but is post-mortem — it fires after the crash,
and a slow leak spends days in the danger zone first. Nothing watches
container memory trend. A `docker stats`-based probe (warn when a
worker container's RSS crosses ~1GB) would have caught this weeks
early. The heap-snapshot workflow used here (SIGUSR1 → CDP →
retainer-graph summary) is generic and fast; scripts are reusable.

## Follow-ups

- [ ] Memory-trend probe for Box A worker containers (warn at ~1GB
      RSS) alongside the existing restart probe.
- [ ] Report upstream to nostr-tools: `getHex64` should flatten the id
      slice (or `_knownIds` should bound its size) — every long-lived
      subscribeMany user leaks this way.
- [ ] The `463555bb` always-on client re-triggers a full ~740-event
      onboarding re-import every hour via the auth-refresh path
      (`recordAuthenticatedPubkey` clears the done-marker hourly).
      Harmless for memory now, but wasteful — consider skipping the
      re-scan when the imported set hash is unchanged. Ties into the
      still-open "which client of 463555bb loops" item from
      `2026-07-17-archive-queue-duplicate-flood.md`.
- [ ] zap-listener replay idempotency (receipt event-id dedup before
      `HINCRBY`), after which it can move off subscribeMany too.
