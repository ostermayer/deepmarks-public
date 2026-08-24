# 2026-08-05 — strfry LMDB at 70% of mapsize; replica map was unmonitored

> Severity: low. Written 2026-08-05.

## Symptom

`strfry-mapsize` warning from `deepmarks-a` at 2026-08-05T12:00:01Z:
data.mdb at 7,529,381,888 bytes of the 10,737,418,240-byte map (70%).

## Impact

None — the warning fired exactly as designed, 30% before the wall.
At 100% every write fails with `MDB_MAP_FULL` while reads (and every
read-only probe) stay green; that state was never approached.

## Root cause

Organic growth: ~2.25M events, ~13MB/day (no flood signature — 1,257
events in the trailing 24h, consistent with the 14-day baseline). The
10 GB map was simply sized for an earlier database.

The investigation found one real defect: the mapsize probe's volume
glob `*strfry-db*` can never match Box B's `strfry-replica-db` volume,
so the replica's map — same data, same growth curve, same 10 GB wall —
was silently unmonitored. Had the primary's map been raised without
the replica's, the replica would have hit `MDB_MAP_FULL` months later
with no warning, breaking replication invisibly (until the 1h
`strfry-replica-stale` freshness probe caught the symptom).

## Timeline

- **2026-08-05 12:00Z** — warning fires at 70%.
- **12:30Z** — mapsize raised 10G → 20G on primary
  (`deploy/box-a/strfry/strfry.conf`) and replica
  (`deploy/box-b/strfry-replica.conf`); both containers
  `--force-recreate`d (bind-mounted conf files pin the pre-pull inode —
  same quirk as Caddy); `STRFRY_MAPSIZE_BYTES=21474836480` set in
  `/etc/deepmarks-monitoring.env` on both boxes; probe fixed to loop
  all `*strfry*db*` volumes with per-volume alert keys. Commit
  `58cdc01`.
- **12:31Z** — replication reconciled after the restarts; resource-check
  runs clean on both boxes (35% of the new map); counts verified.

## Fixes

`58cdc01` — 20 GB map on both sides (~2.5 years of runway at current
growth; both disks absorb a fully-grown map with >50 GB to spare), and
the per-volume mapsize probe.

## Detection gap

The primary-side probe worked. The replica-side gap existed since the
probe was written — a glob written against Box A's volume name. The
loop now monitors any strfry volume present on the box it runs on;
alert keys are `strfry-mapsize-<volume>` so primary and replica dedup
independently.

## Follow-ups

- None. (This report originally claimed the 1-event replica surplus
  was "a live NIP-09 behavior, created in the trailing 24h" — both
  halves were wrong. The 24h-window observation was an artifact of
  computing `since` ~25s apart on the two boxes, and the surplus is
  not NIP-09 at all. Corrected in
  [`2026-08-05-replica-surplus-event.md`](2026-08-05-replica-surplus-event.md).)
