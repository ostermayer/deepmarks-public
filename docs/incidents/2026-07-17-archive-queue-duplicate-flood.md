# 2026-07-17 — Archive queue at 20.5k jobs, 88% duplicates from one client's retry loop

> Severity: high (week-long archive delays for all users; duplicate
> encrypted blobs, some likely undecryptable). Written 2026-07-17,
> updated as the client-side investigation concludes.

## Symptom

`GET /health/archive` had returned 503 for ~7 days — `oldest archive
job has waited 296778s` (3.4 days), `pending: 20531` — unnoticed
because the uptime alert pipeline was down (see the silent-monitoring
report; both incidents were found in the same investigation).

## Impact

- Every user's new archives waited days behind the flood for about a
  week; the worker's ~1,700 terminal jobs/day were mostly spent
  re-archiving the same URLs.
- Duplicate completions stored duplicate encrypted blobs on the primary
  and mirrors (dedupe by content is impossible: each copy is encrypted
  with a different key, so ciphertexts differ).
- Because the client generated a **fresh archiveKey per retry**, most
  duplicate copies are undecryptable by anyone — only the copy whose
  key the client still holds is useful.

## Root cause

A client-side retry loop multiplied by three server-side gaps:

1. One owner's client re-submitted its private backfill (~2,380
   distinct URLs, webpage + media-add-on jobs) over 6 days, minting a
   fresh archiveKey each time — top URLs reached 58 copies.
2. `POST /archive/lifetime` deliberately exempted `tier=private` from
   **every** dedupe ("explicit private archives stay allowed") —
   `api/src/routes/archive.ts`.
3. `/add-on/media-archive/enqueue` had no dedupe at all.
4. Even the public-tier dedupe claim's 6-hour TTL
   (`archive-dedupe.ts`) is shorter than a backed-up queue wait, so
   each lapse re-admits one duplicate — a positive feedback loop (more
   copies → longer waits → more lapses).

Queue analysis (full scan, aggregates only — payloads carry private
keys): 20,528 entries, 2,380 distinct (owner, url) groups, 18,148
redundant; **all** 2,118 duplicate groups had distinct archiveKeys per
copy.

## Timeline

- **2026-07-11 → 07-17** — flood builds; `/health/archive` goes and
  stays 503 (unpaged — monitoring was down).
- **2026-07-17** — found via the monitoring investigation; dedupe
  shipped and queue compacted the same day.

## Fixes

- **Pending-archive claim** (`0311f96`): held per (family, owner, url)
  for a job's whole queued/in-flight lifetime; families `lifetime` vs
  `media` are separate namespaces (a page archive and a media job of
  the same URL are both legitimate). Applied to private lifetime
  enqueues and the media add-on route. Duplicates get the existing
  `queued:` sentinel (`queued:already-pending`) — deliberately **not**
  the pending jobId, so a retry's fresh key is never bound to an old
  job (that would make the eventual archive undecryptable for the
  client). Released on both terminal callback paths (value-matched);
  7-day TTL as a lost-callback backstop.
- **Queue compaction** (one-off, operator-approved): race-free via
  RENAME-aside (workers idle on the fresh key; new claim-guarded
  enqueues land safely), kept the **newest** payload per group (the
  copy whose key the retrying client most plausibly still holds) at the
  **first-seen** position (fairness), seeded pending claims for every
  kept job. Result: 20,488 → 2,380; head age fell 3.4 d → ~27 h; drain
  ~1.4 days.

## Detection gap

`/health/archive` caught it on day one — but its alert died in the
broken cron pipeline. With monitoring fixed, this class pages within
15 minutes (three consecutive probe failures). The queue-composition
analysis scripts (aggregate-only duplicate/key scans) are reusable from
the session records if surgery is ever needed again.

## Follow-ups

- **Client-side — RESOLVED same day.** Code investigation across all
  surfaces (web/iOS/Android share one frontend; the extension is the
  second codebase) confirmed fresh-key-per-enqueue everywhere, and
  identified the **browser extension backfill**
  (`browser-extension/src/lib/lifetime-archive-backfill.ts`) as the
  loop behind the flood: unlike the web loop, it had **no
  server-queue backpressure** (the web app halts at 250 outstanding
  server jobs — that throttle would have engaged during the flood,
  exonerating web/mobile), it re-armed every ~1 minute while work
  remained, and it dropped its local dedupe entry exactly when a slow
  queue made job status records lapse (404) — then re-enqueued with a
  fresh key. Fixed in the same commit as this report update: the
  extension loop now (1) checks `/account/archive-queue` and waits
  while ≥ 250 jobs are outstanding, mirroring the web app, and (2)
  handles the `queued:` sentinel like the web loop — suppress the URL
  for the TTL, never stash/publish a key against the sentinel, never
  poll it as a jobId (the status route 400s it). Regression test:
  `tests/browser-extension/lib/media-archive.test.ts`. Ships with the
  next extension release (web/mobile needed no change — their sentinel
  handling already existed).
- The private-tier **permanent-failure** gate exemption remains
  deliberate and unchanged; only pending-dedupe was added.
- **Backlog-age paging tuned (same day).** The compacted backlog
  (~1,878 flood-era `lifetime:` jobs) drains FIFO at ~1,000/day, so
  `/health/archive` 503'd on `oldest archive job has waited …` for the
  ~2-day drain even though the worker was provably alive (heartbeat
  0s, callbacks flowing). The uptime probe paged hourly on a capacity
  condition, not an outage. Changed (`api/src/archive-health.ts`):
  backlog age past the 24 h threshold is a **warning** when the worker
  heartbeat is fresh, and remains a 503 **issue** when the heartbeat is
  missing/stale (which already pages on its own). Worker-death paging
  is unchanged.
- **Overnight flap (2026-07-17→18).** The fix above sat committed but
  undeployed overnight; as the backlog drained, the queue-head age
  oscillated across the 24 h line and the uptime probe emailed
  down/recovered pairs for hours. A second flap source: the probe's
  10 s timeout vs. an endpoint measured at 14 s under load while
  returning 200. Both closed 2026-07-18 — api deployed (`1848f98`),
  probe timeout raised to 30 s (`a4afbb0`). The worker was healthy
  throughout; no jobs were lost.
