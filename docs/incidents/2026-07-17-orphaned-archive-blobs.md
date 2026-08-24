# 2026-07-17 — 14 archive records reference blobs that no longer exist anywhere

> Severity: medium (14 of 39,445 referenced blobs — 0.035%; 10 private
> ones unrecoverable). Written 2026-07-17; private-record decision
> pending.

## Symptom

The nightly non-destructive restore drill
(`deepmarks-restore-test.service`) failed its blob-sampling step: blob
`8620004d…` downloaded as HTTP 404. This was the drill's **first run
whose failure could actually page** — it had been failing since at
least the previous night, but the alert died in the broken cron
pipeline (see `2026-07-17-silent-monitoring.md`).

## Impact

A full audit of every blob hash referenced by live archive records
(39,445 distinct hashes, HEADed against the primary) found **14
missing**, none with a surviving copy on any of the three mirrors:

- **10 private blobs, one owner (`f28e5ba0…`)** — legacy-era records
  (no `kind` field, no `bookmarkSavedAt`). Encrypted, bytes gone
  everywhere: unrecoverable server-side. The owner's archive list
  shows these as archived; downloads would 404.
- **4 public webpage archives, owner `2944e915…` (the brand
  account)** — archiveofourown.org pages saved 2026-04-18/20,
  predating the multi-mirror era.

## Root cause

Not conclusively pinned. All 14 predate the current
refcount/mirror-retry machinery; the affected records carry an **empty
refcount set** (`dm:archive:refs:<hash>` has no members) while the
record exists — consistent with records created before refcounting,
whose blobs were later deleted by a path that consulted the (empty)
refcount. The June 2026 storage incident
(`../archive-sync-2026-06-03.md`) is a plausible era for the actual
deletions. No evidence of ongoing loss: every post-refcount blob
checked out.

## Fixes

- **4 public orphans re-enqueued** (2026-07-17) through the real
  lifetime path; on completion the callback's repair path replaces the
  record and removes the dead hash. Job ids `lifetime:8b5aa49e…`,
  `d74bcf18…`, `6fa1030d…`, `22f3ec82…`.
- **Restore drill hardened** (`2f5e930`): a sampled 404 now checks
  production Redis — hash no longer referenced live → skip (deletion
  race between snapshot and drill, previously a false hard-fail); hash
  still referenced → fail loudly (true orphan). The drill's sampler
  scans deterministically, so until the orphans are cleared it will
  keep sampling the same broken hashes — by design.

## Detection gap

The drill was doing its job; its alarm was lost to the silent alert
pipeline. With alerting fixed, a future orphan pages within a day. The
full-audit script (aggregate-only, HEADs every referenced hash) lives
in the session records and takes ~5 minutes; worth re-running after
any storage migration.

## Follow-ups

- **RESOLVED (operator approved, 2026-07-17):** the 10 private
  orphaned records (owner `f28e5ba0…`) were deleted — server cannot
  rebuild them (client-side keys, bytes gone everywhere), and leaving
  them meant an archive list promising downloads that 404 plus nightly
  drill failures. Deletion one-off verified owner + tier + audited
  hash before each HDEL; 10/10 deleted, 0 skipped; empty refcount keys
  cleaned. The owner can re-archive from their client if the bookmarks
  remain. No orphaned records remain — the next drill run should pass.
- **Verified (same day):** a manual drill re-run after the cleanup
  passed end-to-end (strfry restore + 3/3 sampled blobs verified),
  clearing the stale failed-unit alert from the 04:31 pre-cleanup run.
  The 4 re-enqueued repair jobs were still behind the flood backlog
  (see `2026-07-17-archive-queue-duplicate-flood.md`), so they were
  moved to the queue head (guarded LREM+LPUSH) to close the window in
  which the drill could sample their still-referenced dead hashes.
