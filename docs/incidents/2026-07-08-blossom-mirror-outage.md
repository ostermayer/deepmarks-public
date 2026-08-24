# 2026-07-08 — Primal mirror outage exposed unretried fanout legs

> Severity: low (no data loss; redundancy gap only). Written 2026-07-17.

## Symptom

Operator alert `archive-mirror-fanout-partial` for job
`lifetime:de4d3fc1834f7e292e11cd4854e2beec` (a ucla.edu stats page):
primary Blossom upload succeeded, the single configured mirror failed —
`https://blossom.primal.net: mirror HTTP 500; direct upload failed:
blossom upload failed: 500 db error`.

## Impact

The blob was safe on the primary throughout. But the investigation
found the systemic gap: **failed mirror legs were never retried
anywhere** — a mirror outage at archive time permanently cost that
archive its mirror redundancy, with only the alert as an artifact. Any
partial-fanout alert before this date represents an archive that was
missing its mirror copy until repaired.

## Root cause

1. Primal had a transient (~1 hour) database outage: blob lookups hung
   20 s, `/mirror` and `/upload` returned `500 db error`. Recovered on
   its own; the blob simply never landed there.
2. The worker's fanout (`archive-worker/src/worker.ts`) ran exactly once
   per job. No retry queue, no admin re-mirror command.

## Timeline

- **2026-07-08 20:20Z** — alert fired.
- **2026-07-08 (next session)** — diagnosis; signed BUD-06
  `HEAD /upload` probes of eleven public Blossom servers to pick
  additional mirrors (only `nostr.download` and `cdn.nostrcheck.me`
  accepted an unknown pubkey's text/html; blossom.band/nostr.build use
  per-npub subdomains + media-only free tiers, f7z.io/oxtr.dev are
  whitelisted, satellite.earth was down/paid).
- Same day — mirror set expanded to three; the failed blob re-mirrored
  by one-off with the worker's own signing key (preserves delete
  authority); retry sweep built, tested, deployed (`5abf87e`).
- Within minutes of deploy, live traffic surfaced two more bugs, fixed
  same day (`d8e93cb`, `48b7cfc` — see Fixes).

## Fixes

- **Mirror set**: `BLOSSOM_MIRROR_URLS=blossom.primal.net,nostr.download,cdn.nostrcheck.me`
  (box-b `.env`).
- **Mirror retry queue** (`5abf87e`): failed legs park in the
  `dm:archive:mirror:retry` ZSET; the worker retries with 5m → 30m → 2h
  → 8h → 24h backoff (~34 h), then abandons. Retries drop if the blob
  left the primary (resurrection guard); deletes purge pending retries
  and sweep **all currently-configured** operator mirrors (a 404/410
  DELETE is treated as success), so late-mirrored copies tear down
  without archive-record updates.
- **Permanent-leg filter** (`d8e93cb`): cdn.nostrcheck.me
  magic-byte-sniffs uploads and 400s every encrypted blob ("file type
  not detected") — an all-4xx error signature (excluding 408/429) is
  never retried. Practical shape: public HTML lands on all three
  mirrors; encrypted private/media blobs land on primal +
  nostr.download only.
- **Auth nonce** (`48b7cfc`): a `/mirror` attempt and its direct-upload
  fallback in the same epoch second produced byte-identical
  `kind:24242` auth events (same id); id-tracking servers rejected the
  fallback with `401 Auth event already used`. Auth events now carry a
  `nonce` tag.
- **Alert policy**: first narrowed to zero-redundancy-only, then
  (2026-07-17) mirror-fanout emails were removed entirely — see the
  silent-monitoring report for the replacement primary-Blossom probe.

## Detection gap

Nine days of retry-queue stats after the fix: 1,608 retry entries
scheduled, only 3 exhausted — i.e. the pre-fix world had been silently
dropping mirror copies that a short wait would have recovered. The
partial-fanout alert *did* fire per incident, but was noise (nothing
operator-actionable), which is what eventually got the emails removed.

## Follow-ups

None open. Retry stats are visible in worker logs
(`mirror retry attempt complete`).
