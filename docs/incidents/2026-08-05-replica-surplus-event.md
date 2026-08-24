# 2026-08-05 — replica surplus event: not NIP-09; primary lost a committed event without trace

> Severity: low (single public event; DR direction benign). Written 2026-08-05.
> **Resolved 2026-08-22:** the event was restored to the primary from the
> replica (`strfry scan` by id on Box B piped into `strfry import` on
> Box A — `1 added, 0 rejected`; presence verified by id scan). Note:
> the runbook's `strfry sync --dir down` route does NOT work for this —
> the strfry-stream sidecar container lacks the write-policy plugin
> mount, so the policy blocks the incoming event with "internal error";
> `strfry import` bypasses the policy by design. The daily negentropy
> probe should report convergence from its next run.

## Symptom

Since 2026-08-04, every negentropy comparison between the primary and
the Box B replica reports `Have 0 need 1`: the replica holds exactly
one event the primary lacks. Totals confirm (e.g. 2,260,682 vs
2,260,683). Initially logged in the 08-04 and 08-05 reports as "the
NIP-09 a-tag deletion divergence class" — **that label was wrong**;
this investigation corrects it.

## The event

Identified by full ID-set diff (`strfry scan '{}'` → id per line →
`sort` → `comm`, both sides; one pass, exact):

- id `74fc6e2977b79a1eb8d0c8f0d444ea5c240257f7a66593ef0e09d7a57beee307`
- kind 30000 follow set, title "music", 9 p-tags, d
  `3a9c9748-c2e2-492b-ab46-fd28e3d2eeb6`
- author `3eacaa76…` (external curator — the kind FollowsIngester
  pulls from external relays), created_at 2026-06-08

## What it is NOT (each ruled out by data)

- **Not NIP-09**: no kind:5 by that author exists on either relay
  (and only same-pubkey kind:5s can delete). The earlier "NIP-09
  divergence class" attribution is retracted.
- **Not a replaceable-event race**: zero other events exist at the
  (kind, pubkey, d) address on either side — the event was never
  replaced, and the primary/replica ID sets differ by exactly this one
  id in the full-DB diff (no divergent "winners").
- **Not NIP-40/ephemeral**: no expiration tag; kind 30000 is not
  ephemeral.
- **Not a crash rollback**: strfry opens LMDB with full-sync commits
  (no NOSYNC anywhere in strfry/golpe/rasgueadb; verified in source at
  our pinned builds), and a *process* segfault cannot unwrite
  committed pages — dirty mmap pages belong to the kernel, not the
  process. Only a host crash could, and Box A has 40+ days uptime. The
  Jun–Aug segfaults are therefore not the mechanism, despite the
  suggestive timing.
- **Not a measurement artifact**: the full ID diff is exact. (One
  earlier claim WAS an artifact: "the surplus event was created in the
  trailing 24h" came from comparing windowed counts whose `since` was
  computed ~25s apart on each box — a boundary event, not the surplus.
  Corrected in the 08-05 mapsize report.)

## What remains

Every replica write path originates from the primary's committed DB
(seed export, live stream, `sync --dir up` pushes; the replica is
VPC-only and Box B's firewall admits 7777 only from 10.0.0.2). So the
primary **committed this event at some point** and later lost it via
some path that leaves no event trace. Known such paths: `strfry
delete` CLI or direct DB surgery — but no repo code, script, runbook,
or shell history invokes `strfry delete` (and the 2026-07-17
"10 private records deleted" surgery was Redis HDELs, not relay
events). Caveat: non-interactive SSH sessions record no shell history,
so ad-hoc surgery cannot be ruled out either way. The alternative is
an unknown removal bug in the strfry build we ran until 2026-08-04
(1.1.0-81, since upgraded past two memory-corruption-class fixes).

The definitive evidence — the RelayWriter "Inserted event" log line
with its wall-clock timestamp on either box — is gone: Docker
json-file logs were removed with the container recreates of Aug 4–5.
Bracket from counts: divergence arose after the 2026-07-17 reconcile
("counts match") and was present by 2026-08-04 23:41Z.

## Resolution options (operator decision)

The event is a curator's public follow list; there is no deletion
record, so nothing marks it as intentionally removed.

1. **Restore to primary** (recommended): push it back with a filtered
   sync from the replica, restoring convergence. Reversible — it can
   always be properly deleted later with a real kind:5 or `strfry
   delete` on both sides.
2. **Delete from replica**: `strfry delete` on Box B. Choose this only
   if the primary-side removal is believed intentional (nothing found
   suggests it was).

## Detection gap → fix

No probe compared the event SETS — freshness and the watchdog only
catch a dead stream, and windowed counts can miss a single old event
forever. `deepmarks-resource-check` (Box A) now runs a daily read-only
negentropy comparison (`strfry sync --dir none`, 03:0x run;
`REPLICA_DIVERGENCE_FORCE=1` to run manually) and alerts
`strfry-replica-divergence` with primary-only/replica-only counts, or
`strfry-replica-divergence-probe-failed` if the probe itself can't
run. Until the surplus event is resolved, the daily alert will fire —
that is intentional pressure, not noise.

## Follow-ups

- Operator: pick resolution option 1 or 2 above; the daily divergence
  alert clears once converged.
- If a future divergence alert shows `replica-only > 0` again with no
  deletion trace, treat it as a possible strfry bug and capture the
  RelayWriter container logs on BOTH boxes immediately, before any
  container recreate destroys them.
