# 2026-07-29 — restore drill false alarm: NIP-09 deletions applied during strfry import

> Severity: low. Written 2026-07-29.

## Symptom

Critical alert `service-deepmarks-restore-test.service`: the nightly
non-destructive restore drill failed with

```
✗ restored strfry event count mismatch: got 2040024 expected 2040025
```

after an otherwise clean run (RDB verified, gzip + 2,040,025 event
JSON lines verified, import reported `2040025 added, 0 rejected,
0 dups`). Exactly one event short, and the import log contains the
explanation:

```
INFO| Deleting replaceable event (kind 5, a-tag). id=8a468c34…
```

## Impact

None. The backup object is byte-verified and complete; every exported
event was imported. The restored copy differs from live by one event
that a stored kind:5 deletion legitimately targets — the restored DB
is arguably *more* NIP-09-correct than the live one. Cost: one red
drill run and the investigation.

## Root cause

`strfry import` runs deletion processing. The export contains, in
insertion order, a kind:30000 follow set (`tribes/TestTribe3`, an
external NoorNote user mirrored by the follows-ingester; live export
line 1,981,347) followed by a kind:5 `a`-tag deletion of that address
(line 1,986,370, `created_at` newer than the target). Replaying that
order, import stores the 30000, then processes the kind:5 and deletes
it — restored count 2,040,024.

The live relay holds **both** events: it accepted the kind:5 after the
target was already stored but did not apply the deletion at ingest,
while the same `box-a-strfry:latest` binary does apply it at import.
(The user deleted the tribe on Jun 21, re-created it Jun 29, deleted it
again Jul 1 — only the re-creation and both kind:5s survive live.)
Which ingest path stored the kind:5 without applying it is still open —
candidates are the negentropy/replication path added 2026-07-17 versus
normal relay ingest.

The drill's invariant — restored export line count must equal the
manifest's `eventCount` — was therefore wrong whenever the snapshot
contains a deletion whose target also survives live.

## Timeline

- 2026-07-29 04:20 UTC — nightly drill starts; fails 04:37 with the
  count mismatch; alerts begin (resource-check every 15 min, dedup
  re-sends while the unit stays failed).
- 2026-07-30 00:30 UTC — investigation: deleted id resolved against
  live strfry (kind:30000 `tribes/TestTribe3`), both kind:5 a-tag
  deletions found, insertion order confirmed via `strfry export`
  line numbers — proving import-time deletion of a live-surviving
  target, not backup loss.
- 2026-07-30 — drill check fixed (`d3571c7`), deployed (git pull on
  Box A; script runs from the repo checkout). Re-run passed at
  00:52 UTC: `2040024 events (1 removed at import by stored kind:5
  deletions)`, Redis restore (860,822 keys) and 3 sampled archive
  blobs verified; unit back to inactive, alert condition cleared.

## Fixes

`d3571c7` — `deploy/box-a/restore-test.sh` now captures the import
log and counts `INFO| Deleting ` lines: the invariant becomes
`restored + deletions-at-import == manifest eventCount`. Every missing
event must be matched by an explicit deletion log line; unexplained
discrepancies (and spurious deletion lines, which push the sum over)
still fail the drill. When deletions occur, the drill prints them.

No backup-side change: the manifest's `eventCount` correctly describes
the export file.

## Detection gap

None — the drill exists precisely to catch restore-behavior surprises,
and the alert pipeline delivered it. This was the drill working as
designed against an invariant that was slightly too strict.

## Follow-ups

- [ ] Determine why live strfry ingest did not apply the kind:5 a-tag
      deletion that import applies (replication path vs relay ingest
      deletion semantics). If live should honor it, decide whether to
      delete `8a468c34…` from the live DB (operator call — external
      user's deleted test tribe).
- [ ] The next drills will exercise the new deletion-aware path daily
      (the snapshot keeps both events); confirm the first few runs stay
      green.
