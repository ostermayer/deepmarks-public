# Deepmarks Android 2.2.12

Archive retry backoff plus the web-bundle fixes shipped since 2.2.11.

- **Failed archives now back off instead of retrying forever.** The
  lifetime-archive backfill keeps a per-URL failure ledger synced with
  the server's cooldown: a URL that failed to archive waits 6 hours
  before its next attempt, doubling per consecutive failure up to 30
  days, and resets when it finally archives. This ends the retry loop
  that re-submitted dead URLs every pass (2026-08-21 incident) and the
  status line now reports "N failed archives waiting out retry backoff".
- **Live results in the per-list search overlay.** Searching inside a
  list shows matches as you type instead of after submit.
- **Security: non-http(s) bookmark URLs are rejected** at render sinks
  and ingest, so a crafted `javascript:`/`data:` bookmark can neither be
  saved nor rendered as a link.
- **Native shell: subheader icons stay on the sort row** instead of
  wrapping below it.
- **BTCPay checkout: radio and checkbox switches display correctly**
  (the theme no longer restyles them).
- **iOS parity:** `2.2.12` / build `42` to match the Android
  `2.2.12` / `versionCode 42` bump.
