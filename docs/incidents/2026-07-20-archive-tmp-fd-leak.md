# 2026-07-20 — archive-tmp disk 90%: fd leak pinned 85GB of deleted temp files

> Severity: medium. Written 2026-07-20.

## Symptom

Alerter warning at 2026-07-20T16:45Z: `/dev/sdc` mounted at
`/mnt/deepmarks-archive-tmp` on Box B at 90% capacity. The suggested
`du` showed almost nothing: visible directories totaled **46MB** against
**85GB** used per `df`. A second alert at 21:00Z reported 98%; by the
time it was investigated the mount was at **100% (764MB free)** with
the leak grown to 598 fds.

## Impact

Operator-only; the worker logs showed no ENOSPC failures before
mitigation, so no jobs were lost — but at 764MB free the next
substantial media download would have failed paid archives. Nothing
was lost.

## Root cause

`lsof +L1` on the mount showed the archive-worker node process (up 11
days) holding **548 open read fds on deleted files** — all
`deepmarks-video-*/fragmented.mp4.dmchunk` encrypted upload temps —
summing to ~85GB of unreclaimable space.

The mechanism, in `archive-worker/src/blossom.ts` `uploadFileTo()`:

1. The encrypted chunk file is streamed to Blossom via
   `body: createReadStream(filePath)` passed to undici `fetch`.
2. When the fetch fails **without fully consuming the body** — mirror
   timeout via `AbortSignal.timeout` (up to 15 min for big blobs),
   connection refused/reset, or a server that responds before reading
   the whole body — undici does not destroy the request-body stream.
   The fd stays open in the worker forever.
3. The job's temp-dir cleanup then unlinks the file. With an open fd,
   ext4 keeps the blocks allocated; `du` no longer sees them but `df`
   does.

Each failed upload/mirror attempt against a large video leaked one fd
(~46/day, accelerating with media volume). Two mirror-side failure
modes supplied a steady stream of exactly these failures via the
`/mirror` fallback path, which direct-uploads the full ciphertext to
each failing mirror:

- **`cdn.nostrcheck.me` 400-rejects every media blob** ("file type not
  detected or not allowed, mime: application/octet-stream" — media
  ciphertext is intentionally octet-stream). The server responds
  before consuming the request body, which is precisely the case that
  leaks the fd. Every media job leaked at least one fd through this
  leg.
- `nostr.download` was flapping with 502s (see
  `2026-07-08-blossom-mirror-outage.md` for prior mirror flakiness).

`sha256File()` in the same module also uses `createReadStream` but is
not implicated — it always reads to end, which auto-closes.

## Timeline

- 2026-07-08 (approx) — worker container last restarted; leak clock
  starts.
- 2026-07-20 16:45Z — disk alert fires at 90%.
- 2026-07-20 ~17:45Z — diagnosis: `du`/`df` mismatch → `lsof +L1` →
  548 deleted-but-open `.dmchunk` fds owned by the worker. Fix
  committed (`62ea346`) but restart/deploy pended on operator
  approval.
- 2026-07-20 21:00Z — second alert at 98%; mount reached 100%
  (764MB free), 598 leaked fds.
- 2026-07-20 ~21:10Z — operator approved; `28a6253` pulled,
  `archive-worker` rebuilt and recreated. Disk dropped 100% → 1%,
  zero deleted-but-open fds, worker healthy and processing.

## Fixes

- `62ea346` — `uploadFileTo()` wraps the fetch in `try/finally` and
  calls `body.destroy()` unconditionally. Destroy is a no-op on a
  fully-consumed stream; on every failure path it closes the fd so the
  unlinked file's space is freed.
- Mitigation + deploy (2026-07-20 ~21:10Z, combined into one restart):
  `cd /opt/deepmarks-repo && git pull` (as dan — `sudo git pull` fails
  host-key verification; root has no GitHub known_hosts) then
  `cd deploy/box-b && sudo docker compose up -d --build archive-worker`.
  Recreating the worker also recreates the `wg` sidecar (shared
  netns); residential egress verified working post-restart.

## Detection gap

The disk alert worked as designed — this is the pipeline fixed in
`2026-07-17-silent-monitoring.md` earning its keep. What it couldn't
see is *why* `du` and `df` disagreed. Two cheap probes would catch a
recurrence long before 90%:

- alert on `df`-vs-`du` divergence for the archive-tmp mount (e.g.
  warn when unaccounted space exceeds 10GB), or more directly
- alert on the worker's open-fd count against deleted files
  (`lsof +L1` count > ~50).

## Follow-ups

- [x] Restart `archive-worker` on Box B — done 2026-07-20 ~21:10Z,
      combined with the deploy.
- [x] Deploy `62ea346` to Box B — done, on `28a6253`.
- [x] Add the deleted-but-open-fd probe to the Box B alerter cron —
      done 2026-07-20 (`a20b01e`): `deepmarks-resource-check` sums
      unique deleted-open inodes on the archive-tmp device (lsof
      filtered by device number — the mount-path arg doesn't reliably
      scope lsof), warns at 10GB under key `archive-tmp-deleted-fds`.
      Live-fire tested on Box B with a held-open deleted 100MB file.
- [ ] nostrcheck rejecting encrypted blobs is *known and accepted*
      (documented since 2026-07-08; the retry queue already drops
      those legs as permanent). The narrower open question: the
      *initial* fanout still runs the full-ciphertext direct-upload
      fallback against nostrcheck on every media job, which can never
      succeed — consider skipping the fallback for octet-stream →
      nostrcheck so the attempt (and its bandwidth) isn't wasted.
- [ ] Consider fd-leak sweep of other `createReadStream`-as-body call
      sites if any appear later (only `uploadFileTo` exists today).
