# 2026-08-21 — Client backfill retry loop on dead URLs pages uptime-critical while Wayback is down

> Severity: medium (no user-facing outage — worker healthy, queue empty;
> ~800 wasted render jobs in 30h and a critical uptime page held red for
> ~1.5h until fixed). Written 2026-08-21 at resolution.

## Symptom

`uptime-archive-worker` paged critical from Box C at 17:05:03Z:
`GET https://api.deepmarks.org/health/archive` returning 503. The body
showed the worker itself healthy (heartbeat 0s, `pending: 0`,
`processing: 0`) but
`archive webpage retryable failure spike (163/278 recent jobs)` —
only **1** webpage archive had completed in 24h against 277 failures.

## Impact

- No availability impact: the queue was drained and the worker alive
  the whole time. The "outage" was the pager, not the service.
- ~800 wasted Playwright render jobs in 30h on Box B (all failing), at
  MAX_CONCURRENT_JOBS=1 — real archive work would have queued behind
  the churn.
- The uptime pager was held critical by a condition that could not
  clear for ~24h on its own (the SLA window), burning alert trust.

## Root cause

Four interacting causes; the first two are ours, the third external,
the fourth an alert-semantics defect:

1. **Client backfill retries failed archives forever.** The web app's
   lifetime-archive backfill (`frontend/src/lib/nostr/lifetime-archive-
   backfill.ts`) releases its client-side queue slots for failed
   archives on every pass (`releaseFailedArchiveQueueSlots`) with no
   attempt budget. While the tab is open it re-submits every
   still-missing URL each cycle (~14 min — the time the single-
   concurrency worker takes to chew through the failing batch). The
   failure histogram gaps 01:00–04:00Z exactly like a closed laptop.
2. **The server enqueue gate covered permanent failures only — and
   exempted private tier and media entirely.** The 2026-07-17
   duplicate-flood fix gated re-enqueue on
   `hasRecentPermanentArchiveFailure` (not-found / too-large, 30-day
   window) — but every claim that dedupes in-flight jobs is released
   by the terminal callback, so a **retryable** terminal failure made
   the URL immediately re-enqueueable. `POST /archive/lifetime`
   accepted the same dead URL again every cycle, minting a fresh
   `lifetime:<random>` jobId each time — **92 duplicate jobs for one
   2002 washingtonpost.com URL** (`.../ac2/wp-dyn?...notFound=true`).
   Round 2, discovered after the first fix deployed: that URL is a
   **private** bookmark, and both the private lifetime path ("explicit
   private stays allowed", a pre-automated-retry-era exemption) and
   `/add-on/media-archive/enqueue` bypassed the gate — the loop kept
   cycling every ~2 min through tier=private until those were gated
   too.
3. **The Internet Archive was down (from Box B's vantage).** The
   worker's Wayback fallback (`archive-worker/src/wayback.ts`) got the
   "Internet Archive: Temporarily Offline" HTML page from
   `archive.org/wayback/available` (reproduced live from the worker
   container; the same URL answered 200/JSON from a residential IP).
   Dead/bot-walled URLs whose only viable source is Wayback therefore
   failed terminally as `retryable` (ERR_HTTP2 / timeouts / 403s)
   instead of being rescued — and never converted to `permanent`, so
   gate (2) never engaged. The trigger batch: one lifetime member
   (`463555bb…`) imported ~100+ old bookmarks starting 08-20 ~20:58Z —
   dead 2002 news URLs, flickr, mobile.twitter.com, archive.is,
   invidious instances.
4. **The spike detector conflated content failure with availability.**
   It counted raw failed jobs (inflated 92× by the loop) and fed
   `issues` → 503 → the uptime probe. All recent failure records
   belonged to **one owner**; a broken pipeline fails every active
   owner, a graveyard import fails one. It also could only clear ~24h
   after the last failure rolled out of the SLA window.

## Timeline (UTC)

- **08-20 20:58** — first enqueue of the batch by owner `463555bb…`;
  ~250 failures over 21:00–24:00.
- **08-21 01:00–04:00** — silence (client offline); loop resumes 04:00
  and runs all day at ~30–45 failures/h.
- **08-21 17:05** — SLA spike crosses threshold → `/health/archive`
  503 for 3 consecutive probes → `uptime-archive-worker` critical.
- **08-21 17:28–18:00** — investigation: worker/container/host healthy;
  92 distinct jobIds for one URL; enqueues traced to
  `lifetime archive enqueued (free)` from one pubkey at client-shaped
  hours; Wayback outage reproduced from the worker's own netns.
- **08-21 18:04** — deploy 1 (`b2a618c`): escalating terminal-failure
  cooldown gate + scanner-JSON 400 fix (see the sibling report).
- **08-21 18:10** — deploy 2 (`a4a6986`): distinct-URL count sourced
  from the failure hashes (done-records carry no url — first cut
  degenerated to per-job counting).
- **08-21 18:14** — deploy 3 (`4289b2e`): spike pages only when it
  spans ≥2 owners; single-owner mass failure is a warning.
- **08-21 18:15** — `/health/archive` 200 `ok:true` with
  `archive webpage retryable failures concentrated in one owner
  (169/284 recent jobs, 175 distinct URLs, 1 owner)` as a warning;
  uptime probe green on its next tick.
- **08-21 18:13–18:18** — loop observed still cycling every ~2 min as
  **tier=private** (the gate exempted private); round-2 diagnosis.
- **08-21 18:22** — deploy 4 (`ac73348`): gate applied to private tier
  and the media add-on enqueue. 18:23:40 — first live block:
  `lifetime archive enqueue skipped — recent terminal failure`
  (`tier: private`, `consecutiveFailures: 4` → 48h window). A sibling
  dead-import URL with no recent record got its one allowed retry in
  the same cycle — the designed bounded behavior.

## Fixes

All in `api`, deployed to Box A (`api` + `worker-payments`):

- **Escalating re-enqueue cooldown** (`archive-failures.ts`,
  `routes/archive.ts`, `archive-lifecycle.ts`): `getRecentArchiveFailure`
  gates automated enqueue of any owner+URL whose last terminal failure
  is recent — permanent reasons keep the 30-day window; retryable
  reasons start at 6h and double per consecutive failure
  (`consecutiveFailures`, reset by success) up to the 30-day cap. Both
  `POST /archive/lifetime` and the backfill-candidate path consult it.
  Gated requests return the existing `queued:` sentinel
  (`queued:recent-failure`), which already lands deployed clients on
  their "already queued / skipped" path — the loop dies without a
  client update. The gate covers **all tiers** on `/archive/lifetime`
  and the media add-on enqueue (`routes/youtube-archive.ts`); private
  dupes are the worst kind, since each mints a fresh archiveKey
  (2026-07-17), and `/archive/browser-capture` remains the escape
  hatch for genuinely blocked private pages. Deliberate operator
  retries (`archive-retry`, `archive-rescue`) bypass the gate on
  purpose.
- **Spike detector counts distinct URLs and owners**
  (`archive-health.ts`): sourced from the per-owner failure hashes
  (one entry per owner+URL by construction). Pages (`issues` → 503)
  only at ≥25 distinct URLs across ≥2 owners with the ≥50% failure
  ratio; single-owner mass failure surfaces as a health warning
  instead. This also let the pager clear immediately instead of
  after ~24h of SLA-window rolloff.
  **2026-08-22 addendum:** "≥2 owners" was trivially met the next
  morning by ONE stray failure from a second owner next to the
  import's 123 (false page at 11:40Z). The paging condition now
  requires ≥10 distinct failing URLs OUTSIDE the most-affected owner
  (`webpageRetryableFailedUrlsBeyondTopOwnerLast24h`).

## Follow-ups

- **Client backfill politeness — shipped same day**: the client keeps a
  per-URL failure-backoff ledger
  (`frontend/src/lib/nostr/archive-backoff.ts`) mirroring the server's
  escalating curve (6h · 2^(n-1), 30-day cap). Backfill candidates with
  an active backoff are filtered out before any request; the ledger is
  fed by locally observed job failures and by the server's
  `queued:recent-failure` / `queued:permanent-failure` sentinels, and
  cleared when the URL finally archives. The status line surfaces
  "N failed archives waiting out retry backoff".
- **Wayback-miss visibility — shipped same day**: `fetchWaybackIfFresh`
  now reports WHY it missed (`availability-unparseable` = the IA outage
  page, `availability-http-<status>`, `no-snapshot`, `snapshot-too-old`,
  …) and the worker logs it (`wayback fallback miss after render
  failure` / `wayback rescue miss`) besides recording it in the audit
  trail. An IA outage now shows up as a wall of
  `availability-unparseable` in `docker logs` instead of having to be
  inferred from failure timing.
- **Stranded URLs**: the ~175 failure records now back off on the
  escalating schedule. Once the Internet Archive is back, a deliberate
  `archive-retry` / `archive-rescue` pass (dry-run first) can recover
  the ones with snapshots.
