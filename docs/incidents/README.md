# Incident reports

Every production bug or operational incident gets a dated report in this
directory, written when the incident is resolved (or contained, if
follow-ups remain). This is a standing rule, not a nice-to-have: twice in
2026 the *investigation of one symptom* uncovered unrelated silent
failures weeks old (see `2026-07-17-silent-monitoring.md`). Reports are
how the next investigation starts from knowledge instead of archaeology.

Pre-convention incident records live at the docs top level and stay
there: [`../archive-sync-2026-06-03.md`](../archive-sync-2026-06-03.md)
and the incident log inside
[`../reliability-2026-06.md`](../reliability-2026-06.md). New reports go
here.

## Index

| Report | Severity | One-line summary |
|---|---|---|
| [`2026-07-08-blossom-mirror-outage.md`](2026-07-08-blossom-mirror-outage.md) | low | Primal mirror outage exposed that failed mirror legs were never retried — retry queue built, mirror set expanded to three |
| [`2026-07-17-silent-monitoring.md`](2026-07-17-silent-monitoring.md) | high | Every cron-sent operator alert had failed silently since install (PATH bug); the bunker probe could never succeed |
| [`2026-07-17-archive-queue-duplicate-flood.md`](2026-07-17-archive-queue-duplicate-flood.md) | high | 20.5k-job archive queue, 88% duplicates from one client's retry loop — private/media enqueues had no dedupe |
| [`2026-07-17-orphaned-archive-blobs.md`](2026-07-17-orphaned-archive-blobs.md) | medium | Restore drill caught 14 records referencing blobs gone from primary and all mirrors; 4 public re-archived, 10 private unrecoverable |
| [`2026-07-20-archive-tmp-fd-leak.md`](2026-07-20-archive-tmp-fd-leak.md) | medium | archive-tmp at 90% with `du` seeing 46MB — undici fetch never destroys a failed upload's body stream; 548 fds pinned 85GB of deleted `.dmchunk` temps |
| [`2026-07-27-relay-sync-heap-oom.md`](2026-07-27-relay-sync-heap-oom.md) | medium | relay-sync crash-looped on 2GB heap OOM for 3 weeks — subscribeMany's id dedup pins every raw relay frame via V8 sliced strings; workers moved to relay-level subscriptions |
| [`2026-07-29-restore-drill-nip09-deletion.md`](2026-07-29-restore-drill-nip09-deletion.md) | low | Restore drill red on a 1-event count mismatch — strfry import applies stored kind:5 a-tag deletions the live relay never applied; drill now requires every missing event to match a logged deletion |
| [`2026-08-04-strfry-replica-stale-sidecar-strand.md`](2026-08-04-strfry-replica-stale-sidecar-strand.md) | medium | strfry segfault killed the pid-ns-sharing strfry-stream sidecar and a Docker restart race stranded it Exited — replica drifted 2.3 days; also surfaced recurring strfry GPF crashes since 2026-06-25 |
| [`2026-08-05-strfry-mapsize-70pct-replica-blindspot.md`](2026-08-05-strfry-mapsize-70pct-replica-blindspot.md) | low | Primary LMDB map at 70% (organic growth, raised 10G→20G both sides) — and the mapsize probe's glob had silently never monitored the Box B replica's map |
| [`2026-08-05-replica-surplus-event.md`](2026-08-05-replica-surplus-event.md) | low | The replica's 1-event surplus is NOT NIP-09 (attribution retracted): the primary lost a committed kind-30000 event with no deletion trace, cause unprovable (logs rotated) — daily negentropy set-divergence probe added |
| [`2026-08-21-archive-backfill-retry-loop.md`](2026-08-21-archive-backfill-retry-loop.md) | medium | Client backfill re-minted jobs for one user's dead URLs every ~14 min (92 dupes of one URL) while Wayback was down — terminal failures now carry an escalating re-enqueue cooldown across all tiers (private + media included); the SLA spike pages only when it spans ≥2 owners |
| [`2026-08-21-scanner-json-500-pages.md`](2026-08-21-scanner-json-500-pages.md) | low | Scanner POST with malformed JSON hit the raw-bytes JSON parser and paged as an unhandled 500 — parse errors now carry statusCode 400 |

## When to write one

Write a report when any of these happened in production:

- users or the operator saw wrong behavior (even if self-healed),
- data was lost, duplicated, or made unreadable,
- an alert fired that required investigation (or should have fired and
  did not),
- a fix required touching live state by hand (queue surgery, re-mirror
  one-offs, key rotation).

Routine deploys, refactors, and bugs caught before production do not
need one.

## Template

```markdown
# YYYY-MM-DD — <short title>

> Severity: low | medium | high. Written YYYY-MM-DD.

## Symptom
What was observed, verbatim where possible (alert text, user report).

## Impact
Who/what was affected, for how long, and what was permanently lost (if
anything).

## Root cause
The mechanism, not the patch. Include the contributing causes — most
incidents here have more than one.

## Timeline
Discovery → diagnosis → fix, with dates and commit hashes.

## Fixes
Commits, deploys, and any manual production surgery (with exact
commands or scripts referenced).

## Detection gap
Why existing monitoring/tests didn't catch it, and what now would.

## Follow-ups
Open items, with owners if known.
```
