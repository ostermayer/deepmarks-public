# 2026-07-17 — Every cron-sent operator alert had failed silently since install

> Severity: high (monitoring integrity; no user-facing data loss).
> Written 2026-07-17.

## Symptom

None — that is the incident. While investigating repeated mirror-fanout
emails (sent by the api's own alerter, which was healthy), a routine
check of the Box C uptime state directory found failure counters in the
thousands with no corresponding emails ever delivered:

```
/var/lib/deepmarks-uptime/box-c.fail:          3044   (~10.5 days)
/var/lib/deepmarks-uptime/archive-worker.fail: 2019   (~7 days)
/var/lib/deepmarks-uptime/box-b-worker.fail:  16464   (stale target name)
```

## Impact

- **All alerts from `deepmarks-uptime-check` and
  `deepmarks-resource-check` (all three boxes) were silently lost since
  installation.** Disk/RAM/LMDB warnings, uptime criticals — none ever
  reached the operator via cron.
- A real, week-long `/health/archive` 503 (the archive-queue backlog,
  see the duplicate-flood report) went unpaged for ~7 days.
- The `box-c` probe had been failing for 10.5 days — but that one was a
  false alarm (see root cause 2); the bunker was healthy throughout.

## Root cause

Three independent gaps:

1. **Cron PATH.** Both check scripts invoke `deepmarks-alert` by bare
   name. It lives in `/usr/local/bin`; cron's default PATH is
   `/usr/bin:/bin`; the cron lines end in `>/dev/null 2>&1`. Every
   send died on "command not found" with the error discarded. Manual
   runs (with a login shell's PATH) worked — which is why spot checks
   never noticed. Evidence: alert dedup markers are touched only on
   successful Resend delivery, and the only recent marker mtimes
   matched a manual test run, not the cron cadence.
2. **Probe against a deliberately closed port.** The `box-c` probe
   targeted `http://127.0.0.1:4100/health`, but the bunker container
   stopped publishing any host port as part of hardening (SSH is Box
   C's only listener). The probe could never succeed again; the
   container's own Docker healthcheck was green the whole time.
3. **No probe for the primary Blossom server at all** — and the naive
   one would lie: Caddy serves a static landing page at
   `blossom.deepmarks.org/`, which stays green with the blossom-server
   container dead.

## Timeline

- **2026-07-17** — discovered during the mirror-email investigation;
  all three causes diagnosed and fixed the same day.

## Fixes

- `f51b5be` — both scripts `export PATH="/usr/local/bin:$PATH"`; the
  box-c probe now reads the bunker container's Docker healthcheck
  (`probe_docker_health`) instead of a host port — no exposure change.
- `ae2575d` — new `GET /health/blossom` on the api asks the
  blossom-server container directly over the compose network (any
  HTTP answer < 500 counts as alive); `deepmarks-uptime-check` gained a
  `blossom-primary` probe. `3431c66` — the endpoint initially fell to
  the known compose `${VAR:-}` empty-string env gotcha (`??` kept the
  empty string); fixed with trim-then-`||`.
- Ops: scripts reinstalled on all three boxes; stale
  `box-b-worker.fail` removed; `DEDUP_SECONDS=600 → 3600` on Box C so a
  *persisting* critical pages hourly instead of every 10 minutes.
- **Verified end-to-end**: the next cron tick cleared the box-c
  counter and delivered `info uptime-recover-box-c` ("Probe success
  after 3044 consecutive failures") — the first alert this pipeline
  ever delivered from cron.

## Detection gap

The alerting pipeline had no way to report its own failure, and
"silence" is indistinguishable from "healthy". Two things changed:

- The recovery-email mechanism now doubles as a liveness proof — any
  probe that transitions failure→success emails, so a long-silent
  pipeline gets exercised whenever any target blips.
- The `.fail` counters are now meaningful (they page); a counter in the
  hundreds with a quiet inbox is itself the signal to check
  `deepmarks-alert` by hand.

## Follow-ups

- Consider a weekly heartbeat email ("monitoring alive, N probes
  green") so pipeline death is detected in ≤7 days rather than on the
  next incident. Not yet scheduled.

## Addendum — what the first day of live alerts surfaced (2026-07-17)

Once delivery worked, the backlog of silently-failing conditions all
paged at once. Triage of that first wave:

- `backup-systemd-unreadable` — **second PATH bug**: the probe's
  `runuser` lives in `/usr/sbin`, also absent from cron's PATH; the
  first fix only added `/usr/local/bin`. Backups were healthy the
  whole time. Both scripts now prepend `/usr/sbin:/sbin` (`56e3797`).
- `blossom-config-missing` (critical) — checker false positive: it
  grepped for the absolute `/app/config.yml` but the image runs with a
  relative `config.yml` arg. Blossom was healthy on S3 (config
  present, zero local-fallback blobs). Check relaxed (`56e3797`).
- The disk check had **never run**: GNU df rejects `-P` combined with
  `--output`, so the probe errored every time with stderr discarded.
  Fixed same day.
- `strfry-replica-stale` — **real**: the replication profile was still
  off from the pid-namespace/firewall era, and the Box B firewall rule
  now exists. `strfry-stream` started (image pre-built, no OOM-risk
  rebuild), live events flowing within the hour + negentropy reconcile
  for the gap.
- `service-deepmarks-restore-test` (critical) — **real**: the nightly
  restore drill had been failing on an orphaned archive blob. See
  `2026-07-17-orphaned-archive-blobs.md`.
- `disk-/dev/sda` (Box B, 86%) — **real**, and the df fix's first-ever
  catch: 56.5 GB of Docker build cache accumulated across weeks of
  archive-worker image builds. `docker builder prune -af` took the
  disk from 86% to 19%. Worth an occasional prune after heavy deploy
  cycles; the disk check now watches for real.

Pattern worth remembering: every monitoring script here had bugs that
only manifest under cron's environment, and none were detectable while
the delivery pipeline itself was down. After fixing delivery, treat
the first wave of alerts as a mixed bag of true findings and probe
bugs — triage each rather than assuming either.
