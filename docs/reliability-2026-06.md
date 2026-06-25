# Reliability program — June 2026

The complete record of the June 2026 reliability review and the seven
work waves that came out of it: what could go wrong, what we changed,
what now guards each fix, and the one incident along the way. Written
for the operator coming back to this in a year.

Companion docs: [`relay-policy.md`](relay-policy.md) (relay write rules),
[`durable-publish.md`](durable-publish.md) (client publish queue),
[`backup-restore.md`](backup-restore.md) (backups + live replication),
[`media-archive-format.md`](media-archive-format.md) (encrypted blob
formats), [`../tests/README.md`](../tests/README.md) (every regression
guard mapped to its finding).

## Timeline

| Wave | Shipped in | Theme |
|---|---|---|
| Review | — | Six parallel audits over publish, sync, relay durability, kind:1 bookmarks, private-bookmark crypto, archives. ~40 findings. |
| Round 1 | app 2.2.0 / public v0.7.0 | The nine verified data-loss bugs, each pinned by a regression test first |
| Round 2 | app 2.2.1 / v0.7.1 | Signer timeouts + decrypt-failure UX, import pacing, note placeholders/paste |
| Round 3 | app 2.2.2-line / v0.7.2 | Cross-device public deletes, offline queue safety, extension parity |
| Cleanup | v0.7.2 | Dead code, stale docs, schema dedup from the simplification survey |
| Round 4 | v0.7.2 | Archive-key lifecycle, worker self-repair, operator alerting |
| Structural | app 2.2.3 / ext 2.2.2 / v0.7.3 | Per-item private events, shared sync core, chunked media format v2, live relay replication |
| Polish | app 2.2.5 / ext 2.2.4 / v0.7.5 | MSE streaming playback, export completeness, canonical conflict rule; final docs + simplification pass (per-item write path returns one event, shared 429 gate, parity regime grown to four modules) |

Test suite grew from 900 to ~1,030 along the way; every fix below has a
named guard in `tests/*/regression/` (catalog in `tests/README.md`).

## The publish pipeline (why a 202 is now trustworthy)

Clients sign locally and POST to `api.deepmarks.org/publish`; the server
queues to Redis and a fanout worker forwards to strfry, then to the
author's NIP-65 relays. Hardening, in pipeline order:

- **Client durable queue** (`durable-publish.md`): replaceable templates
  are re-stamped (web) / re-signed (extension) at drain time so the
  relay can't discard offline edits as "older"; offline and
  locked-signer drains don't burn the bounded attempt budget; removal
  matches the exact template so an old save's ack can't delete a newer
  queued edit; the bookmarks view shows "N saves waiting to sync"; the
  extension drains from its background worker on a chrome alarm, not
  just while the popup is open.
- **Relay budgets** (`relay-policy.md`): kind:39701 has a dedicated
  1000/h scope (imports used to die in the 200/h general bucket),
  private chunks/tombstones/archive-keys share the 5000/h private-state
  scope, and rejected events no longer count against budgets.
- **Worker retries**: rate-limited events get a 30-attempt budget
  (≈24h+ of backoff — a bulk import drains instead of dropping at 8);
  deterministic policy rejections ("not registered", "kind not
  accepted", clock skew) dead-letter immediately to
  `dm:publish-relay:dead` with an operator alert instead of burning
  retries; successful forwards stamp `dm:publish-relay:last-forward-ts`.
- **Write-path health**: `GET /health/relay` returns 503 when the queue
  has work but nothing has forwarded for 15 min — the wedge every
  read-only probe stays green through. The uptime checker probes it.

## Private bookmarks (the wipe class, eliminated twice)

History: every save/edit/delete used to fetch → decrypt → rewrite the
COMPLETE chunked kind:30003 set. A failed read or undecryptable chunk
became an empty set, and the rewrite erased the library relay-wide —
this happened in production. Round 1 added guards (refuse rewrites on
decrypt failures, honor delete tombstones in cache unions); the
structural release then removed the hazard entirely:

- **Per-item events**: saves/edits publish one replaceable event at
  `d=deepmarks-private-item:<sha256(url)>`; deletes publish only their
  tombstone. No read, no decrypt of existing chunks, no whole-set
  replacement. Conflict surface = one URL. Every shipped reader merges
  item events with chunks (newest per URL wins; iOS had written these
  from its share sheet all along). The bulk importer is the one
  remaining whole-set rewrite and keeps the decrypt-failure guard.
- **Shared core**: chunk selection (including the cross-version union
  recovery), per-item selection, and the tombstone-aware merge live in
  `private-set-core.ts` — byte-identical copies in
  `frontend/src/lib/nostr/` and `browser-extension/src/lib/`, locked by
  a sha256 parity test. Drift between the two implementations was the
  root cause of the original wipe.
- **Signer behavior**: remote-signer (NIP-46/Amber) crypto calls time
  out at 30s instead of hanging the refresh latch; failures are
  classified (`signer-timeout` / `nip44-unsupported` / `wrong-key`) and
  surfaced as an actionable banner instead of a silently smaller list.

Cross-device deletes: the feed keeps a session deletion memory
(NIP-09-validated — forged kind:5s naming someone else's coordinate are
ignored) so late-arriving copies can't resurrect, and an observer hook
prunes the merge-only-never-remove server cache + localStorage, with a
persisted relay-deleted map that a genuinely newer re-save clears.
Replaceable-event tie-breaks follow NIP-01 retention (lowest id) in both
stores so every device renders the copy the relay actually keeps.

## Archives

- **Key lifecycle**: private/media enqueues probe the signer's NIP-44
  support first and fail loudly (a signer that can't encrypt used to
  orphan the AES key in one device's localStorage); the pending-key
  stash records when its relay-side wrap confirmed publishing —
  published entries age out after 14d, UNPUBLISHED entries (the only
  copy in existence) are kept 90d and retried each reconcile pass.
  Archives whose key is unrecoverable on this device are shown on
  /app/archives with an explanation and re-archived automatically with
  fresh keys — media included (they used to vanish).
- **Worker self-repair**: the audit pass calls its repair helpers
  instead of counting deferrals — lost success callbacks are
  re-delivered, failed/stale public archives attempt a Wayback rescue,
  lost private/media jobs are marked failed so clients retry. All
  claim-key-guarded and idempotent.
- **Retrieval**: `fetchArchiveBytes`/`fetchArchiveBlob` fall back to the
  BUD-04 mirrors recorded on the archive record (with sha256
  verification for public blobs) when the primary Blossom server fails.
- **Media playback**: chunked encryption format v2 — see
  [`media-archive-format.md`](media-archive-format.md). Clients
  stream-decrypt into a disk-backed Blob with bounded memory; 1 GB+
  videos play on iOS. Upload/mirror timeouts scale with blob size.

## Relay durability

- **Live replication**: a strfry `router` sidecar on Box A (compose service still named `strfry-stream`) pushes every
  stored event to the VPC-only replica on Box B within seconds —
  RPO went from "last nightly export" (~24h) to near-zero. Runbook
  (seed / reconcile / restore / firewall prerequisite) in
  `backup-restore.md`. Verified converged at deployment:
  817,552 events on both sides.
- **Monitoring**: LMDB map-size alerts at 70/85% (MDB_MAP_FULL is a
  silent total write outage); the admin dashboard's queue gauges watch
  the Redis keys the workers actually use; nightly backups + the daily
  restore test continue unchanged as the second layer.
- **Config**: strfry pinned to the exact production commit
  (1.1.0-81-g1461e6b); `rejectEventsOlderThanSeconds` raised to 10y so
  onboarding scans stop bouncing long-time users' original events;
  `maxWebsocketPayloadSize` raised past `maxEventSize`.

## Incident log

**2026-06-09 23:54–23:58 UTC — relay crash-loop (~4 min).** First
deployment of the replication sidecar. LMDB's lock table tracks readers
BY PID; the sidecar ran in its own PID namespace while sharing the
relay's DB volume, the namespaces collided, and the relay aborted with
`mdb_txn_begin: Resource temporarily unavailable` on every client
connect. **No data lost**: the publish queue absorbed every write
(event count advanced through the outage; nothing dead-lettered).
Recovery: stop the sidecar; the relay self-healed via its restart
policy in ~20s. Permanent fixes: `pid: "service:strfry"` on the
sidecar, and the service sits behind the `replication` compose profile
so it only starts deliberately. Secondary lesson, same deployment:
`rejectEventsOlderThanSeconds = 0` does NOT disable strfry's age check
(it rejects everything older than now) — the replica uses explicit
100-year windows.

## Known remaining work

Closed since first writing: CI (GitHub Actions runs all five suites +
typechecks on every push), share-sheet `nostr:` handling, e-tag note
bookmarks in the main list/search, public-ref relay-hint prefetch,
additive auto-republish (SYNC-F3 — republish now reads the relay first
and only publishes what's missing, never resurrecting deletes), failed
media jobs recorded terminal and skipped for 30 days, replica freshness
alerting, and a locked-state notice in the extension popup.

Still open, roughly by value:

1. **Extension NIP-46/NIP-07 login** — the popup remains nsec-only;
   users whose key lives in a bunker or another extension can't sign in
   there at all. Real project: a signer abstraction through every
   extension signing/encrypt path.
2. **Worker streaming encrypt** — media now remuxes to fragmented MP4
   and STREAMS to the player via MSE (shipped), but the worker still
   buffers ~2× the file during encrypt; file-to-file streaming encrypt
   would drop that peak. (Also shipped since first writing: the
   `strfry router` migration, export coverage for imported bookmarks,
   and the canonical conflict rule — now a parity-copied module,
   `bookmark-merge-core.ts`, byte-identical on both surfaces alongside
   `private-set-core.ts`, `nwc.ts`, and `nsec-backup.ts`.)
