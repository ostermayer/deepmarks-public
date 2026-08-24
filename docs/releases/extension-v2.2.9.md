# Browser extension v2.2.9

Chrome, Firefox, and Safari. Cut 2026-07-18. One theme: stop the
extension's archive backfill from flooding the server queue (the client
side of
[`../incidents/2026-07-17-archive-queue-duplicate-flood.md`](../incidents/2026-07-17-archive-queue-duplicate-flood.md)).

## Fixed

- **Backfill backpressure.** The lifetime-archive backfill now checks
  the account's outstanding server jobs (`/account/archive-queue`) and
  waits while 250 or more are pending or running — the same ceiling the
  web app has always had. Previously the loop had no ceiling and
  re-armed every minute, which against a slow server queue re-enqueued
  the same URLs indefinitely (40-58 duplicate jobs per URL in the July
  incident, each with a freshly generated archive key).
- **`queued:` sentinel handling.** When the server answers an enqueue
  with a `queued:`-prefixed sentinel (`already-pending`,
  `permanent-failure`), the URL is now suppressed for the usual 7-day
  window without stashing or publishing the fresh key against the
  sentinel, and the sentinel is never polled as a job id (the status
  route rejects it with 400 — older builds survived that only by
  accident and re-polled it every run for a week).
- **Accurate backfill counts.** Media backfill counts
  sentinel/already-claimed URLs as skipped instead of dropping them
  from both counters.

## Notes

- No manifest-permission changes; no user-facing UI changes.
- Server-side protection (pending-archive claims) shipped independently
  on 2026-07-17, so older extension builds are already contained — this
  release removes the wasted enqueue attempts and status polls at the
  source.
- Regression coverage:
  `tests/browser-extension/lib/media-archive.test.ts`.
