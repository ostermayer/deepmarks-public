# 2026-08-04 — strfry replica stale: segfault killed pid-ns sidecar, restart race stranded it

> Severity: medium. Written 2026-08-04.

## Symptom

Alerter warning from `deepmarks-b` at 2026-08-04T22:15:02Z, key
`strfry-replica-stale`:

> The replication stream from Box A appears broken — the replica is
> drifting toward backup-only staleness.

## Impact

The VPC-only strfry replica on Box B (`10.0.0.3:7777`) received no new
events from 2026-08-02 14:35 UTC until 2026-08-04 23:37 UTC (~2.3
days). No data was lost and nothing user-facing was affected — the
replica is a disaster-recovery copy. The exposure was risk-only: had
Box A been lost during the window, recovery would have started from a
replica ~2 days behind instead of seconds behind (i.e. no better than
the nightly backups).

Separately, the investigation surfaced that the primary strfry relay
has been segfaulting sporadically since 2026-06-25 (20 crashes across
two container generations; roughly one every 1–2 days recently). Each
crash auto-restarts in under a second and the relay passes its
healthcheck, so this had been invisible. It remains unresolved — see
Follow-ups.

## Root cause

Three layers, each necessary:

1. **strfry segfaults sporadically.** `dmesg` shows general protection
   faults inside libc (`traps: strfry[…] general protection fault … in
   libc.so.6`) — heap corruption somewhere in strfry 1.1.0-81-g1461e6b.
   The Docker journal records exit 139 with `restartCount` climbing
   (13 on the current container). On 2026-08-02 14:35:55Z one of these
   crashes took down the relay container.

2. **The sidecar dies with the relay by design.** `strfry-stream` runs
   with `pid: "service:strfry"` (required so sidecar and relay share
   one PID namespace for LMDB locking on the shared volume — see
   `deploy/box-a/compose.yml`). When the namespace-owner container
   dies, Docker SIGKILLs every joiner, so the sidecar exited 137. This
   part is expected and had recovered cleanly on prior crashes (e.g.
   2026-08-01 16:03Z, where logs show the sidecar reconnecting).

3. **Docker's restart race stranded the sidecar.** Both containers
   restarted concurrently under `unless-stopped`. The sidecar's restart
   attempted to join the relay's PID namespace while the relay was
   itself still mid-restart, and dockerd logged:

   > restartmanger wait error: failed to join PID namespace: Container
   > d8a65e… is restarting, wait until the container is running

   After that error the restart manager gave up permanently — it does
   not retry — leaving `box-a-strfry-stream-1` in `Exited (137)` while
   the relay came back healthy without its replication sidecar.

## Timeline

- **2026-06-25 onward** — recurring strfry GPF crashes (7 on the
  previous container generation, 13 on the current one), each
  auto-restarted and unnoticed.
- **2026-08-01 16:03Z** — segfault; sidecar restarted successfully and
  reconnected (the benign version of the race).
- **2026-08-02 14:35:55Z** — segfault; sidecar killed with the pid
  namespace, lost the restart race, stranded `Exited (137)`.
  Replication stops here.
- **2026-08-02 14:55Z, 2026-08-04 15:07Z** — two further relay
  segfaults; sidecar already dead.
- **2026-08-04 22:15Z** — `strfry-replica-stale` warning fires from
  Box B.
- **2026-08-04 23:32Z** — diagnosis complete; sidecar started with
  `docker compose --profile replication up -d strfry-stream`;
  connected to `ws://10.0.0.3:7777` immediately.
- **2026-08-04 23:33–23:37Z** — negentropy reconcile pushed the missed
  backlog (600+ events) up to the replica.
- **2026-08-04 23:37Z** — verified: primary and replica both count
  exactly 7627 events with `since` = 4 days ago.

## Fixes

Shipped 2026-08-05 (same session as resolution):

- `a3ad162` — `deepmarks-resource-check` gains a Box A watchdog: if
  replication is enabled and the sidecar isn't running, it revives it
  (`docker compose --profile replication up -d --no-deps
  strfry-stream`), reconciles via `strfry sync --dir up`, and emails
  `strfry-stream-revived` (warning) / `strfry-stream-revive-failed`
  (critical). Worst-case strand is now 15 min, self-healing. The Box B
  replica-staleness threshold drops 24h → 1h
  (`REPLICA_MAX_EVENT_AGE_SECONDS`; worst measured inter-event gap over
  14 days of traffic is 24 min). **Live-fire tested on Box A**:
  `docker stop box-a-strfry-stream-1`, then one resource-check run
  detected, revived (sidecar back in ~2s), reconciled, and delivered
  the email (Resend 200, dedup marker stamped 2026-08-05T00:00:34Z).
- `addb0a9` — strfry pin bumped `1461e6b` (1.1.0-81) → `37f2812`
  (1.1.1-112): picks up the empty-tag filter out-of-bounds-read fix
  and the golpe uWebSockets memory fix (the crash-class suspects for
  the GPFs), plus the WSConnection reconnect-stall fix on the
  router/sync path. `ARG MAKE_JOBS=2` caps build parallelism so image
  builds stop OOM-risking the 8GB box. Deployed to Box A relay +
  sidecar (healthy, plugin filtering, stream connected, counts
  verified) and to the Box B replica.

Original manual production surgery at resolution time:

```
# Box A, /opt/deepmarks-repo/deploy/box-a
docker compose --profile replication up -d strfry-stream
docker compose --profile replication run --rm strfry-stream \
  strfry sync ws://10.0.0.3:7777 --dir up
# verify (same JSON filter on both boxes):
docker exec box-a-strfry-1        strfry scan --count '{"since":<epoch>}'   # Box A
docker exec box-b-strfry-replica-1 strfry scan --count '{"since":<epoch>}'  # Box B
```

VPC reachability of `10.0.0.3:7777` was confirmed fine throughout —
the firewall rule and replica container were never the problem.

## Detection gap

The replica-stale probe worked, but it is calibrated as a last line —
it fired only when staleness approached backup-RPO territory, 2.3 days
after the stream died. Nothing watches the sidecar itself:
`strfry-stream` has no healthcheck, so autoheal (which already runs on
Box A) ignores it, and no probe asserts "replication profile is
enabled ⇒ sidecar is running". The relay's own segfaults were also
invisible because sub-second auto-restarts never trip its healthcheck.

## Follow-ups

All three resolution-time follow-ups (auto-revive, segfault chase,
faster staleness signal) shipped 2026-08-05 — see Fixes. Remaining:

- **Confirm the segfaults stop** (owner: dan). The empty-tag
  filter OOB read and the uWebSockets fix are plausible but unproven
  causes. Baseline: GPFs roughly every 1–2 days through 2026-08-04. If
  `dmesg` shows another `traps: strfry` GPF on 1.1.1-112-g37f2812
  after ~a week, take it upstream with the fault details — the
  auto-revive means it no longer breaks replication meanwhile.
- **1-event replica surplus** (owner: dan, low). After the upgrade
  reconcile, the replica counts one event the primary lacks
  ("Have 0 need 1" in `strfry sync`). Initially assumed to be the
  NIP-09 deletion-semantics divergence class — investigated 2026-08-05
  and that attribution was WRONG: no kind:5 exists, no replacement
  exists; the primary lost a committed event without trace. See
  [`2026-08-05-replica-surplus-event.md`](2026-08-05-replica-surplus-event.md)
  for the full rule-out and resolution options.
